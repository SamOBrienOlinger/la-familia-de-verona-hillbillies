from django.core.management.base import BaseCommand
from django.core.validators import validate_email
from family_api.auth import new_invite


class Command(BaseCommand):
    help = 'Issue a single-use, seven-day family invitation; send the printed code privately.'

    def add_arguments(self, parser):
        parser.add_argument('--email', default='')

    def handle(self, *args, **options):
        if options['email']:
            validate_email(options['email'])
        self.stdout.write(new_invite(email=options['email']))
