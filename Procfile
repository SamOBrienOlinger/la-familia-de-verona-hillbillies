release: python manage.py migrate --noinput && python manage.py import_family
web: gunicorn family_backend.wsgi:application --bind 0.0.0.0:$PORT --workers 2 --threads 2 --timeout 30 --access-logfile -
