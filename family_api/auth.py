"""First-party sessions with CSRF checks on anonymous login and registration too."""
import hashlib
import json
import secrets
from datetime import timedelta
from django.conf import settings
from django.contrib.auth import authenticate, login, logout, get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction, IntegrityError
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from .models import Invite
from .services import limit, Problem


def client_key(request):
    # Heroku appends the connecting client to X-Forwarded-For. Never trust the first caller-supplied entry.
    value = request.META.get('REMOTE_ADDR', 'unknown')
    if request.META.get('HTTP_X_FORWARDED_FOR') and __import__('os').environ.get('DYNO'):
        value = request.META['HTTP_X_FORWARDED_FOR'].split(',')[-1].strip()
    return hashlib.sha256((settings.SECRET_KEY + value).encode()).hexdigest()


def session_data(request):
    user = request.user
    return {'csrf': get_token(request), 'user': {'username': user.username, 'staff': user.is_staff} if user.is_authenticated else None,
        'upload_ready': settings.MEDIA_BACKEND == 'local' or bool(settings.CLOUDINARY_URL),
        'registration': 'invitation', 'public_read': True}


def csrf_failure(request, reason=''):
    return JsonResponse({'detail': 'Security token expired. Refresh the page and try again.'}, status=403)


@csrf_protect
@require_http_methods(['GET', 'POST'])
def account(request, action='session'):
    if request.method == 'GET':
        if action != 'session':
            return JsonResponse({'detail': 'Use POST for this action.'}, status=405)
        return JsonResponse(session_data(request))
    try:
        payload = json.loads(request.body or '{}')
        if not isinstance(payload, dict):
            raise ValueError()
        if action == 'logout':
            logout(request)
            return JsonResponse(session_data(request))
        limit('account:' + client_key(request), 30, 900)
        if action in {'login', 'register'} and (not isinstance(payload.get('password'), str) or not 1 <= len(payload['password']) <= 1024):
            raise ValidationError('Enter a password of up to 1024 characters.')
        if action == 'login':
            username = str(payload.get('username', ''))[:150]
            limit('login:' + username.casefold(), 15, 900)
            user = authenticate(request, username=username, password=payload.get('password', ''))
            if user is None:
                return JsonResponse({'detail': 'The username or password was not accepted.'}, status=400)
            login(request, user)
        elif action == 'register':
            username = str(payload.get('username', '')).strip()
            email = str(payload.get('email', '')).strip().lower()
            password = payload.get('password', '')
            code = str(payload.get('invite', ''))
            validate_email(email)
            if not 3 <= len(username) <= 150 or not isinstance(password, str):
                raise ValidationError('Enter a username of 3–150 characters and a password.')
            user = get_user_model()(username=username, email=email)
            user.full_clean(exclude=['password'])
            validate_password(password, user)
            with transaction.atomic():
                invite = Invite.objects.select_for_update().filter(token_hash=hashlib.sha256(code.encode()).hexdigest(), used_at=None, expires_at__gt=timezone.now()).first()
                if not invite or (invite.email and invite.email.casefold() != email.casefold()):
                    return JsonResponse({'detail': 'This invitation is invalid, expired or for a different email.'}, status=400)
                if get_user_model().objects.filter(email__iexact=email).exists():
                    raise ValidationError('An account already uses this email. Sign in or reset its password.')
                user.set_password(password)
                user.save()
                invite.used_at = timezone.now()
                invite.save()
            login(request, user)
        else:
            return JsonResponse({'detail': 'Unknown account action.'}, status=404)
        return JsonResponse(session_data(request))
    except Problem as error:
        return JsonResponse(error.detail, status=error.status_code)
    except ValidationError as error:
        return JsonResponse({'detail': ' '.join(error.messages)}, status=400)
    except IntegrityError:
        return JsonResponse({'detail': 'That account cannot be created. Choose a different username or sign in.'}, status=400)
    except (ValueError, TypeError):
        return JsonResponse({'detail': 'Enter valid account information.'}, status=400)


def new_invite(actor=None, email=''):
    token = secrets.token_urlsafe(32)
    Invite.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), email=email.strip().lower(),
        expires_at=timezone.now() + timedelta(days=7), created_by=actor)
    return token


class SecurityHeaders:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        response['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://res.cloudinary.com; media-src 'self' blob: https://res.cloudinary.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        if request.path.startswith('/api/'):
            response['Cache-Control'] = 'no-store'
        return response
