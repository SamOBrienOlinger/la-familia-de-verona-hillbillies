"""Idempotent first import; never rewrites family edits or source provenance."""
import json
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from family_api.models import Chart, Person, Relationship, Media
from family_api.services import validate_graph


def load_data(filename):
    text = (settings.BASE_DIR / 'dist' / filename).read_text(encoding='utf-8')
    return json.loads(text.split(' = ', 1)[1].strip().removesuffix(';'))


class Command(BaseCommand):
    help = 'Import the original two chart datasets and existing media without overwriting edits.'

    @transaction.atomic
    def handle(self, *args, **options):
        data = load_data('family-data.js')
        graph = load_data('family-graph.js')
        for chart in data['charts']:
            if Chart.objects.filter(pk=chart['id']).exists():
                self.stdout.write(f"Kept existing chart: {chart['id']}")
                continue
            source_graph = graph['charts'][chart['id']]
            c = Chart.objects.create(id=chart['id'], label=chart['label'], source_title=chart['sourceTitle'],
                source_snapshot={'chart': chart, 'graph': source_graph})
            coordinates = {n['id']: n for n in source_graph['nodes']}
            for p in chart['people']:
                Person.objects.create(id=p['id'], chart=c, name=p['name'], aliases=p['aliases'], lines=p['lines'],
                    generation=coordinates[p['id']]['generation'], source_y=coordinates[p['id']]['y'], source_snapshot=p)
            for e in source_graph['edges']:
                a, b = e['source'], e['target']
                if e['type'] == 'partner':
                    a, b = sorted([a, b])
                Relationship.objects.create(id=e['id'], chart=c, source_id=a, target_id=b, kind=e['type'], source_snapshot=e)
            for group_id in set(p['mediaGroup'] for p in chart['people'] if p['mediaGroup']):
                m = data['mediaGroups'][group_id]
                media, _ = Media.objects.get_or_create(id=group_id, defaults={'kind': m['type'], 'url': '/static/' + m['src'],
                    'poster': '/static/' + m['poster'] if m.get('poster') else '', 'caption': m['caption'],
                    'alt': m['alt'], 'consent_confirmed': True, 'source_snapshot': m})
                media.people.add(*[p['id'] for p in chart['people'] if p['mediaGroup'] == group_id])
            validate_graph(c.pk)
            self.stdout.write(self.style.SUCCESS(f"Imported {len(chart['people'])} records for {c.pk}"))
