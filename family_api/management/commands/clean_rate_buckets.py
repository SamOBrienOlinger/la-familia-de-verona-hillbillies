from django.core.management.base import BaseCommand
from django.utils import timezone
from family_api.models import RateBucket


class Command(BaseCommand):
    help = 'Remove expired, non-content rate-limit counters.'
    def handle(self, *args, **options):
        count, _ = RateBucket.objects.filter(expires_at__lt=timezone.now()).delete()
        self.stdout.write(f'Removed {count} expired counters.')
