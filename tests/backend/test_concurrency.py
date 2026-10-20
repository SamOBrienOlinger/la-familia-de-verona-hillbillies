"""Concurrency invariants must be tested with PostgreSQL, not SQLite's test locks."""
import io
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from django.db import connection, close_old_connections
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TransactionTestCase
from rest_framework.test import APIClient
from family_api.models import Person, Relationship


@skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL row locks; covered by the backend CI job.')
class ConcurrentEditingTests(TransactionTestCase):
    def setUp(self):
        call_command('import_family', stdout=io.StringIO())
        self.user = get_user_model().objects.create_user(username='ConcurrencyTest', email='race@example.test', password='Only-for-concurrency-tests-2026')
        self.a = Person.objects.create(chart_id='renee', name='Concurrent A')
        self.b = Person.objects.create(chart_id='renee', name='Concurrent B')

    def together(self, operation):
        barrier = Barrier(2)
        def worker(index):
            close_old_connections()
            try:
                client = APIClient(); client.force_authenticate(get_user_model().objects.get(pk=self.user.pk))
                barrier.wait(timeout=10)
                return operation(client, index).status_code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            return sorted(pool.map(worker, [0, 1]))

    def test_only_one_parallel_update_can_use_the_same_version(self):
        result = self.together(lambda client, i: client.patch('/api/people/' + self.a.pk + '/', {'name': 'Writer ' + str(i)}, format='json', HTTP_IF_MATCH='1'))
        self.assertEqual(result, [200, 409])
        self.a.refresh_from_db(); self.assertEqual(self.a.version, 2)

    def test_parallel_parent_cycle_proposals_cannot_both_commit(self):
        ids = [self.a.pk, self.b.pk]
        result = self.together(lambda client, i: client.post('/api/relationships/', {'chart': 'renee', 'source': ids[i], 'target': ids[1-i], 'kind': 'parent'}, format='json'))
        self.assertEqual(result, [201, 400])
        self.assertEqual(Relationship.objects.filter(source__in=ids, target__in=ids, deleted_at=None).count(), 1)
