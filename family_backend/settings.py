"""Django/Heroku configuration. Production fails closed without a durable database."""
import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.environ.get('DEBUG', 'false').lower() == 'true'
TESTING = os.environ.get('FAMILY_TESTING') == '1'
if TESTING and os.environ.get('DYNO'):
    raise ImproperlyConfigured('FAMILY_TESTING cannot be enabled on a Heroku dyno.')
SECRET_KEY = os.environ.get('SECRET_KEY', '')
if not SECRET_KEY:
    if DEBUG or TESTING:
        SECRET_KEY = 'local-development-only-not-valid-for-production-' + 'x' * 32
    else:
        raise ImproperlyConfigured('Set a private SECRET_KEY environment variable.')
ALLOWED_HOSTS = [s.strip() for s in os.environ.get('ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',') if s.strip()]
if TESTING:
    ALLOWED_HOSTS.append('testserver')
DATABASES = {'default': dj_database_url.config(
    default='sqlite:///' + str(BASE_DIR / 'local.sqlite3'), conn_max_age=0 if TESTING else 60,
    conn_health_checks=True, ssl_require=bool(os.environ.get('DYNO')))}
if os.environ.get('DYNO') and DATABASES['default']['ENGINE'] != 'django.db.backends.postgresql':
    raise ImproperlyConfigured('Heroku requires a PostgreSQL DATABASE_URL; SQLite is local-only.')
if not DEBUG and not TESTING and not os.environ.get('DATABASE_URL'):
    raise ImproperlyConfigured('Set DATABASE_URL before production startup.')
INSTALLED_APPS = [
    'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
    'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles',
    'rest_framework', 'corsheaders', 'family_api',
]
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware', 'whitenoise.middleware.WhiteNoiseMiddleware',
    'corsheaders.middleware.CorsMiddleware', 'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware', 'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware', 'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware', 'family_api.auth.SecurityHeaders',
]
ROOT_URLCONF = 'family_backend.urls'
WSGI_APPLICATION = 'family_backend.wsgi.application'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [BASE_DIR / 'family_api' / 'templates', BASE_DIR / 'dist'], 'APP_DIRS': True,
    'OPTIONS': {'context_processors': ['django.template.context_processors.request',
        'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages']}}]
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_DIRS = [BASE_DIR / 'dist']
STORAGES = {'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'}}
MEDIA_ROOT = BASE_DIR / 'local-media'
MEDIA_URL = '/local-media/'
MEDIA_BACKEND = os.environ.get('MEDIA_BACKEND', 'local' if DEBUG or TESTING else 'cloudinary')
if not DEBUG and not TESTING and MEDIA_BACKEND != 'cloudinary':
    raise ImproperlyConfigured('Production uploads require Cloudinary, not the dyno filesystem.')
CLOUDINARY_URL = os.environ.get('CLOUDINARY_URL', '')
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_VIDEO_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_BYTES = MAX_VIDEO_BYTES
DATA_UPLOAD_MAX_MEMORY_SIZE = 256 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
FILE_UPLOAD_HANDLERS = ['family_api.media.UploadLimit',
    'django.core.files.uploadhandler.MemoryFileUploadHandler',
    'django.core.files.uploadhandler.TemporaryFileUploadHandler']
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not (DEBUG or TESTING)
CSRF_COOKIE_SECURE = not (DEBUG or TESTING)
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_AGE = 60 * 60 * 12
SESSION_SAVE_EVERY_REQUEST = False
SECURE_SSL_REDIRECT = not (DEBUG or TESTING)
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https') if os.environ.get('DYNO') else None
SECURE_HSTS_SECONDS = 31536000 if not DEBUG and not TESTING else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'
CORS_ALLOWED_ORIGINS = [s for s in os.environ.get('CORS_ALLOWED_ORIGINS', '').split(',') if s]
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = [s for s in os.environ.get('CSRF_TRUSTED_ORIGINS', '').split(',') if s]
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticatedOrReadOnly'],
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination', 'PAGE_SIZE': 100,
    'EXCEPTION_HANDLER': 'family_api.views.api_exception',
}
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
LANGUAGE_CODE = 'en-ie'
TIME_ZONE = 'UTC'
USE_TZ = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
EMAIL_BACKEND = os.environ.get('EMAIL_BACKEND', 'django.core.mail.backends.console.EmailBackend' if DEBUG or TESTING else 'django.core.mail.backends.smtp.EmailBackend')
EMAIL_HOST = os.environ.get('EMAIL_HOST', '')
EMAIL_PORT = int(os.environ.get('EMAIL_PORT', '587'))
EMAIL_HOST_USER = os.environ.get('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = os.environ.get('EMAIL_HOST_PASSWORD', '')
EMAIL_USE_TLS = os.environ.get('EMAIL_USE_TLS', 'true').lower() == 'true'
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = os.environ.get('DEFAULT_FROM_EMAIL', 'noreply@localhost')
LOGGING = {'version': 1, 'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'INFO'}}

CSRF_FAILURE_VIEW = "family_api.auth.csrf_failure"

AUTH_USER_MODEL = 'family_api.User'
