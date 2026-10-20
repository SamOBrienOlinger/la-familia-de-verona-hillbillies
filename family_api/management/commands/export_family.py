import json
from django.core.management.base import BaseCommand
from django.db import transaction
from family_api.models import Chart, Person, Relationship, Media
from family_api.services import snapshot_record, lock_tree


class Command(BaseCommand):
    help = 'Export editorial records, Trash and source provenance to stdout (not passwords). Use pg:backups for full recovery.'

    @transaction.atomic
    def handle(self, *args, **options):
        lock_tree()
        export = {'format': 'family-editorial-v1', 'charts': list(Chart.objects.values()),
            'people': [snapshot_record(x) for x in Person.objects.all()],
            'relationships': [snapshot_record(x) for x in Relationship.objects.all()],
            'media': [snapshot_record(x) for x in Media.objects.all()]}
        self.stdout.write(json.dumps(export, ensure_ascii=False, default=str))
