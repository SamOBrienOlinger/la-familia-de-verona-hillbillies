import re
from django.conf import settings
from django.contrib.auth import views as auth_views
from django.db import transaction, IntegrityError, connection
from django.db.models import Q, Sum
from django.http import HttpResponse, JsonResponse, HttpResponseRedirect
from django.core.validators import validate_email
from django.core.exceptions import ValidationError as DjangoValidationError
from django.shortcuts import get_object_or_404
from rest_framework import viewsets, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework.response import Response
from rest_framework.views import exception_handler
from .models import Chart, Person, Relationship, Media, AuditEvent
from .serializers import PersonSerializer, RelationshipSerializer, MediaSerializer, AuditSerializer
from .services import Problem, limit, save_record, trash_record, restore_record, version_check, make_snapshot, lock_tree
from .media import store_upload, discard_upload
from .auth import client_key, new_invite


def api_exception(exc, context):
    if isinstance(exc, IntegrityError):
        return Response({'detail': 'A conflicting record already exists. Refresh and try again.'}, status=409)
    response = exception_handler(exc, context)
    if response is not None and response.status_code == 429:
        response['Retry-After'] = str(response.data.get('retry_after', 60))
    return response


class SharedRecords(viewsets.ModelViewSet):
    """Every active signed-in account can modify every record, regardless of creator."""
    http_method_names = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            limit('edit:' + str(request.user.pk), 240)

    def get_queryset(self):
        qs = self.queryset.all()
        if self.request.query_params.get('trash') == '1':
            if not self.request.user.is_authenticated:
                raise Problem('Sign in to view Trash.', 403)
            qs = qs.filter(deleted_at__isnull=False)
        else:
            qs = qs.filter(deleted_at=None)
        chart = self.request.query_params.get('chart')
        if chart and self.queryset.model != Media:
            qs = qs.filter(chart_id=chart)
        if self.queryset.model == Media:
            person = self.request.query_params.get('person')
            if person:
                qs = qs.filter(people__id=person)
            if not self.request.user.is_authenticated:
                qs = qs.filter(people__deleted_at=None, people__isnull=False)
            qs = qs.distinct()
        return qs

    def retrieve(self, request, *args, **kwargs):
        obj = self.get_object()
        response = Response(self.get_serializer(obj).data)
        response['ETag'] = f'"{obj.version}"'
        return response

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = save_record(request, serializer)
        return Response(self.get_serializer(result).data, status=201)

    def update(self, request, *args, **kwargs):
        obj = self.get_object()
        serializer = self.get_serializer(obj, data=request.data, partial=kwargs.get('partial', False))
        serializer.is_valid(raise_exception=True)
        result = save_record(request, serializer, obj)
        return Response(self.get_serializer(result).data)

    def destroy(self, request, *args, **kwargs):
        return Response(trash_record(request, self.get_object()))

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated])
    def restore(self, request, pk=None):
        return Response(restore_record(request, get_object_or_404(self.queryset.model, pk=pk)))


class PersonViewSet(SharedRecords):
    queryset = Person.objects.all()
    serializer_class = PersonSerializer


class RelationshipViewSet(SharedRecords):
    queryset = Relationship.objects.select_related('source', 'target', 'chart')
    serializer_class = RelationshipSerializer


class MediaViewSet(SharedRecords):
    queryset = Media.objects.prefetch_related('people')
    serializer_class = MediaSerializer

    def upload(self, request, obj=None, partial=False):
        if obj:
            version_check(request, obj)
        payload = request.data
        if getattr(request._request, 'upload_too_large', False):
            raise Problem('The upload exceeds the 20 MB limit.', 413)
        serializer = self.get_serializer(obj, data=payload, partial=partial)
        serializer.is_valid(raise_exception=True)
        file = request.FILES.get('file')
        if not obj and not file:
            raise Problem('Choose an image or video file to upload.')
        if len(request.FILES) > 1 or len(request.FILES.getlist('file')) > 1:
            raise Problem('Upload one file at a time.')
        uploaded = None
        if file:
            limit('upload:' + str(request.user.pk), 20)
            uploaded = store_upload(file)
        try:
            result = save_record(request, serializer, obj, extras=uploaded)
        except Exception:
            if uploaded:
                discard_upload(uploaded)
            raise
        return Response(self.get_serializer(result).data, status=200 if obj else 201)

    def create(self, request, *args, **kwargs):
        return self.upload(request)

    def update(self, request, *args, **kwargs):
        return self.upload(request, self.get_object(), kwargs.get('partial', False))


@api_view(['GET'])
@permission_classes([AllowAny])
def snapshot(request):
    with transaction.atomic():
        lock_tree()
        return Response(make_snapshot())


@api_view(['GET'])
@permission_classes([AllowAny])
def revision(request):
    return Response({'revision': Chart.objects.aggregate(value=Sum('revision'))['value'] or 0})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def history(request):
    qs = AuditEvent.objects.all()
    if request.query_params.get('object_id'):
        qs = qs.filter(object_id=request.query_params['object_id'])
    before = request.query_params.get('before')
    if before:
        try:
            qs = qs.filter(id__lt=int(before))
        except ValueError:
            raise Problem('Invalid history cursor.')
    events = list(qs[:51])
    return Response({'results': AuditSerializer(events[:50], many=True).data,
        'next_before': events[49].pk if len(events) > 50 else None})


@api_view(['POST'])
@permission_classes([IsAdminUser])
def invite(request):
    limit('invite:' + str(request.user.pk), 30)
    email = str(request.data.get('email', '')).strip()
    try:
        if email:
            validate_email(email)
    except DjangoValidationError:
        raise Problem('Enter a valid email address.')
    return Response({'invite': new_invite(request.user, email), 'expires_in_days': 7}, status=201)


def health(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
        return JsonResponse({'status': 'ok'})
    except Exception:
        return JsonResponse({'status': 'unavailable'}, status=503)


def index(request):
    # Static previews remain usable. Only this server-rendered entry point enables shared editing.
    html = (settings.BASE_DIR / 'dist' / 'index.html').read_text()
    html = re.sub(r'(src|href)="(?!https?://|/|#)([^\"]+)"', r'\1="/static/\2"', html)
    html = html.replace('href="/static/index.html"', 'href="/"')
    html = html.replace('<head>', '<head>\n  <meta name="family-api" content="/api/">', 1)
    return HttpResponse(html)


class PasswordReset(auth_views.PasswordResetView):
    email_template_name = 'registration/password_reset_email.html'
    success_url = '/accounts/password_reset/done/'

    def post(self, request, *args, **kwargs):
        if settings.EMAIL_BACKEND == 'django.core.mail.backends.smtp.EmailBackend' and not settings.EMAIL_HOST:
            form = self.get_form()
            form.is_valid()
            form.add_error(None, 'Password reset email is not configured. Contact the family maintainer.')
            return self.render_to_response(self.get_context_data(form=form), status=503)
        try:
            limit('reset:' + client_key(request), 5, 900)
        except Problem as error:
            return JsonResponse(error.detail, status=error.status_code)
        return super().post(request, *args, **kwargs)
