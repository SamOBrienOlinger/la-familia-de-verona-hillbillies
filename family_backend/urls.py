from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.http import HttpResponseRedirect
from django.urls import include, path
from rest_framework.routers import DefaultRouter
from family_api import views, auth

router = DefaultRouter()
router.register('people', views.PersonViewSet)
router.register('relationships', views.RelationshipViewSet)
router.register('media', views.MediaViewSet)
urlpatterns = [
    path('', views.index, name='home'), path('index.html', views.index),
    path('assets/<path:name>', lambda request, name: HttpResponseRedirect('/static/assets/' + name)),
    path('healthz/', views.health), path('admin/', admin.site.urls),
    path('api/account/<str:action>/', auth.account),
    path('api/snapshot/', views.snapshot), path('api/revision/', views.revision),
    path('api/history/', views.history), path('api/invites/', views.invite),
    path('api/', include(router.urls)),
    path('accounts/password_reset/', views.PasswordReset.as_view(), name='password_reset'),
    path('accounts/password_reset/done/', auth_views.PasswordResetDoneView.as_view(), name='password_reset_done'),
    path('accounts/reset/<uidb64>/<token>/', auth_views.PasswordResetConfirmView.as_view(success_url='/accounts/reset/done/'), name='password_reset_confirm'),
    path('accounts/reset/done/', auth_views.PasswordResetCompleteView.as_view(), name='password_reset_complete'),
]
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
