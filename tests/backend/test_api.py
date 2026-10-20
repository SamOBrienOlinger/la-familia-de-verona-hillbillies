import io
import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.test import TestCase, Client, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient
from family_api.models import Chart, Person, Relationship, Media, AuditEvent, Invite, RateBucket
from family_api.auth import new_invite
from family_api.services import Problem, limit, make_snapshot


class CollaborativeAPITests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('import_family', stdout=io.StringIO())
        cls.a = get_user_model().objects.create_user(username='ContributorA', email='a@example.test', password='family-test-password-only-2026')
        cls.b = get_user_model().objects.create_user(username='ContributorB', email='b@example.test', password='family-test-password-only-2026')
        cls.bill_id = 'renee-william-probst-stewart'
        cls.fiachra_id = 'renee-fiachra-kenneth-gaj-o-brien'
        cls.grainne_id = 'renee-grainne-emer-marie-gaj-o-brien'

    def setUp(self):
        self.api = APIClient()
        self.api.force_authenticate(self.a)
        self.directory = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_BACKEND='local', MEDIA_ROOT=Path(self.directory))
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.addCleanup(shutil.rmtree, self.directory)

    def create_person(self, name='Test relative', chart='renee'):
        response = self.api.post('/api/people/', {'name': name, 'chart': chart, 'generation': 1}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def image(self, name='portrait.jpg'):
        data = io.BytesIO()
        picture = Image.new('RGB', (40, 50), 'white')
        exif = Image.Exif(); exif[270] = 'private camera metadata'
        picture.save(data, 'JPEG', exif=exif)
        return SimpleUploadedFile(name, data.getvalue(), content_type='image/jpeg')

    def upload(self, **overrides):
        payload = {'people': [self.bill_id], 'file': self.image(), 'caption': 'Test photo', 'alt': 'Test image', 'consent_confirmed': True}
        payload.update(overrides)
        return self.api.post('/api/media/', payload, format='multipart')

    def test_import_keeps_78_records_and_all_existing_media(self):
        self.assertEqual(Person.objects.count(), 78)
        self.assertEqual(Media.objects.count(), 4)
        self.assertEqual(Media.objects.get(pk='jenna-cromwell').people.count(), 4)
        self.assertEqual(Media.objects.get(pk='bill-stewart').people.count(), 2)
        self.assertEqual(Media.objects.get(pk='fiachra-grainne').people.count(), 2)
        self.assertTrue(Media.objects.get(pk='dan-kole').url.endswith('dan-kole.mp4'))

    def test_import_is_idempotent_and_does_not_revert_edits(self):
        person = Person.objects.get(pk=self.bill_id); person.name = 'Updated Bill'; person.save()
        call_command('import_family', stdout=io.StringIO())
        self.assertEqual(Person.objects.get(pk=self.bill_id).name, 'Updated Bill')
        self.assertEqual(Person.objects.count(), 78)

    def test_public_snapshot_and_graph_relationships(self):
        response = Client().get('/api/snapshot/')
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertEqual(sum(len(c['people']) for c in value['data']['charts']), 78)
        edges = value['graph']['charts']['renee']['edges']
        self.assertTrue(any(e['type'] == 'partner' and self.bill_id in [e['source'], e['target']] for e in edges))
        self.assertEqual(len(edges), Relationship.objects.filter(chart='renee').count())

    def test_anonymous_cannot_create_update_delete_or_restore(self):
        guest = APIClient()
        for method, url, payload in [
            ('post', '/api/people/', {'name': 'Intruder', 'chart': 'renee'}),
            ('patch', '/api/people/' + self.bill_id + '/', {'name': 'Intruder'}),
            ('delete', '/api/people/' + self.bill_id + '/', {}),
            ('post', '/api/people/' + self.bill_id + '/restore/', {}),
            ('post', '/api/media/', {}), ('post', '/api/relationships/', {}),
        ]:
            response = getattr(guest, method)(url, payload, format='json', HTTP_IF_MATCH='1')
            self.assertEqual(response.status_code, 403, url)

    def test_every_contributor_can_edit_another_contributors_record(self):
        created = self.create_person()
        self.api.force_authenticate(self.b)
        response = self.api.patch('/api/people/' + created['id'] + '/', {'name': 'Edited by another contributor'}, format='json', HTTP_IF_MATCH='1')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['version'], 2)
        self.assertEqual(AuditEvent.objects.latest('id').actor_id, self.b.id)

    def test_missing_and_stale_preconditions(self):
        url = '/api/people/' + self.bill_id + '/'
        self.assertEqual(self.api.patch(url, {'name': 'A'}, format='json').status_code, 428)
        self.assertEqual(self.api.patch(url, {'name': 'A'}, format='json', HTTP_IF_MATCH='7').status_code, 409)
        self.assertEqual(Person.objects.get(pk=self.bill_id).version, 1)

    def test_source_snapshot_is_immutable(self):
        before = Person.objects.get(pk=self.bill_id).source_snapshot
        result = self.api.patch('/api/people/' + self.bill_id + '/', {'source_snapshot': {'name': 'changed'}, 'name': 'Bill'}, format='json', HTTP_IF_MATCH='1')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Person.objects.get(pk=self.bill_id).source_snapshot, before)

    def test_invalid_lists_dates_and_generations_are_rejected(self):
        for change in [{'aliases': 'not a list'}, {'generation': 0}, {'generation': 31}, {'lines': ['Birth 2/30/2000']}, {'lines': ['Birth 1/1/2000', 'Death 1/1/1999']}, {'name': ' '}]:
            response = self.api.patch('/api/people/' + self.bill_id + '/', change, format='json', HTTP_IF_MATCH='1')
            self.assertEqual(response.status_code, 400, change)

    def test_parent_cycle_is_rejected_atomically(self):
        # A child cannot be an ancestor of their own recorded parent.
        relation = Relationship.objects.filter(target_id=self.fiachra_id, kind='parent').first()
        before = Relationship.objects.count()
        result = self.api.post('/api/relationships/', {'chart': 'renee', 'source': relation.target_id, 'target': relation.source_id, 'kind': 'parent'}, format='json')
        self.assertEqual(result.status_code, 400, result.data)
        self.assertEqual(Relationship.objects.count(), before)

    def test_partner_ancestor_cycle_is_rejected(self):
        relation = Relationship.objects.filter(target_id=self.fiachra_id, kind='parent').first()
        response = self.api.post('/api/relationships/', {'chart': 'renee', 'source': relation.source_id, 'target': relation.target_id, 'kind': 'partner'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_duplicate_and_cross_chart_connections_rejected(self):
        relation = Relationship.objects.filter(kind='partner').first()
        response = self.api.post('/api/relationships/', {'chart': relation.chart_id, 'source': relation.target_id, 'target': relation.source_id, 'kind': 'partner'}, format='json')
        self.assertIn(response.status_code, [400, 409])
        response = self.api.post('/api/relationships/', {'chart': 'renee', 'source': self.bill_id, 'target': 'bernard-bernard-egelka', 'kind': 'parent'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_create_edit_delete_restore_relationship(self):
        a, b = self.create_person('Test One'), self.create_person('Test Two')
        result = self.api.post('/api/relationships/', {'chart': 'renee', 'source': a['id'], 'target': b['id'], 'kind': 'parent'}, format='json')
        self.assertEqual(result.status_code, 201, result.data)
        url = '/api/relationships/' + result.data['id'] + '/'
        self.assertEqual(self.api.patch(url, {'notes': 'Confirmed by family'}, format='json', HTTP_IF_MATCH='1').status_code, 200)
        deleted = self.api.delete(url, HTTP_IF_MATCH='2')
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.api.post(url + 'restore/', {}, format='json', HTTP_IF_MATCH='3').status_code, 200)

    def test_trash_person_cascades_connections_not_shared_memory(self):
        count = Relationship.objects.filter(target_id=self.fiachra_id, deleted_at=None).count()
        result = self.api.delete('/api/people/' + self.fiachra_id + '/', HTTP_IF_MATCH='1')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Relationship.objects.filter(target_id=self.fiachra_id, deleted_at__isnull=False).count(), count)
        self.assertIsNone(Media.objects.get(pk='fiachra-grainne').deleted_at)
        self.assertEqual(Client().get('/api/people/' + self.fiachra_id + '/').status_code, 404)
        value = make_snapshot()
        self.assertIn('fiachra-grainne', value['data']['mediaGroups'])
        self.assertEqual(value['data']['mediaGroups']['fiachra-grainne']['names'], [Person.objects.get(pk=self.grainne_id).name])

    def test_restore_checks_dependencies_and_keeps_trash_available(self):
        relation = Relationship.objects.filter(target_id=self.fiachra_id).first()
        self.api.delete('/api/people/' + self.fiachra_id + '/', HTTP_IF_MATCH='1')
        response = self.api.post('/api/relationships/' + relation.pk + '/restore/', {}, format='json', HTTP_IF_MATCH='2')
        self.assertEqual(response.status_code, 400)
        response = self.api.post('/api/people/' + self.fiachra_id + '/restore/', {}, format='json', HTTP_IF_MATCH='2')
        self.assertEqual(response.status_code, 200)
        response = self.api.post('/api/relationships/' + relation.pk + '/restore/', {}, format='json', HTTP_IF_MATCH='2')
        self.assertEqual(response.status_code, 200)

    def test_trash_and_audit_require_authentication(self):
        guest = Client()
        self.assertEqual(guest.get('/api/history/').status_code, 403)
        self.assertEqual(guest.get('/api/people/?trash=1').status_code, 403)
        self.assertEqual(self.api.get('/api/history/').status_code, 200)

    def test_real_image_upload_and_metadata_removed(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.data)
        path = Path(self.directory) / Path(response.data['url']).name
        self.assertTrue(path.is_file())
        with Image.open(path) as image:
            self.assertEqual(len(image.getexif()), 0)
        self.assertEqual(Media.objects.get(pk=response.data['id']).people.count(), 1)

    def test_upload_consent_required(self):
        self.assertEqual(self.upload(consent_confirmed=False).status_code, 400)
        payload = {'people': [self.bill_id], 'file': self.image(), 'caption': 'Test', 'alt': 'Test'}
        self.assertEqual(self.api.post('/api/media/', payload, format='multipart').status_code, 400)

    def test_spoofed_image_svg_and_video_are_rejected(self):
        for name, content_type, content in [('bad.jpg', 'image/jpeg', b'not an image'), ('bad.svg', 'image/svg+xml', b'<svg><script/></svg>'), ('bad.mp4', 'video/mp4', b'not a movie')]:
            result = self.upload(file=SimpleUploadedFile(name, content, content_type=content_type))
            self.assertEqual(result.status_code, 400, result.data)

    def test_oversized_image_and_upload_stream_are_rejected(self):
        result = self.upload(file=SimpleUploadedFile('large.jpg', b'x' * (8 * 1024 * 1024 + 1), content_type='image/jpeg'))
        self.assertEqual(result.status_code, 400)
        with override_settings(MAX_UPLOAD_BYTES=20):
            result = self.upload()
            self.assertEqual(result.status_code, 413, result.data)

    def test_media_edit_replace_and_soft_delete_retains_file(self):
        created = self.upload().data
        url = '/api/media/' + created['id'] + '/'
        self.api.force_authenticate(self.b)
        edited = self.api.patch(url, {'caption': 'New caption'}, format='json', HTTP_IF_MATCH='1')
        self.assertEqual(edited.status_code, 200, edited.data)
        replaced = self.api.patch(url, {'file': self.image()}, format='multipart', HTTP_IF_MATCH='2')
        self.assertEqual(replaced.status_code, 200, replaced.data)
        self.assertNotEqual(replaced.data['url'], created['url'])
        self.assertTrue((Path(self.directory) / Path(created['url']).name).exists())
        self.assertEqual(self.api.delete(url, HTTP_IF_MATCH='3').status_code, 200)
        restored = self.api.post(url + 'restore/', {}, format='json', HTTP_IF_MATCH='4')
        self.assertEqual(restored.status_code, 200)

    def test_cloud_storage_unconfigured_does_not_create_database_record(self):
        before = Media.objects.count()
        with override_settings(MEDIA_BACKEND='cloudinary', CLOUDINARY_URL=''):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(Media.objects.count(), before)

    def test_upload_failure_does_not_claim_success(self):
        with patch('family_api.views.store_upload', side_effect=Problem('Temporary storage error', 503)):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(Media.objects.count(), 4)

    def test_login_registration_and_logout_are_csrf_protected(self):
        client = Client(enforce_csrf_checks=True)
        credentials = {'username': self.a.username, 'password': 'family-test-password-only-2026'}
        self.assertEqual(client.post('/api/account/login/', credentials, content_type='application/json').status_code, 403)
        token = client.get('/api/account/session/').json()['csrf']
        response = client.post('/api/account/login/', credentials, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 200)
        token = response.json()['csrf']
        self.assertEqual(client.post('/api/people/', {'name': 'No csrf', 'chart': 'renee'}, content_type='application/json').status_code, 403)
        created = client.post('/api/people/', {'name': 'With csrf', 'chart': 'renee'}, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(created.status_code, 201)
        response = client.post('/api/account/logout/', {}, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertIsNone(response.json()['user'])
        self.assertEqual(client.post('/api/people/', {'name': 'Signed out', 'chart': 'renee'}, content_type='application/json', HTTP_X_CSRFTOKEN=token).status_code, 403)

    def test_invitation_join_single_use_and_no_privilege_escalation(self):
        invite = new_invite(email='joined@example.test')
        payload = {'username': 'Joined', 'email': 'joined@example.test', 'password': 'another-safe-test-password-2026', 'invite': invite, 'is_staff': True}
        response = Client().post('/api/account/register/', payload, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(get_user_model().objects.get(username='Joined').is_staff)
        self.assertFalse(Invite.objects.filter(token_hash=invite).exists())
        payload['username'] = 'JoinedAgain'; payload['email'] = 'other@example.test'
        self.assertEqual(Client().post('/api/account/register/', payload, content_type='application/json').status_code, 400)

    def test_only_maintainer_can_issue_invitations(self):
        self.assertEqual(self.api.post('/api/invites/', {}, format='json').status_code, 403)
        self.a.is_staff = True; self.a.save()
        result = self.api.post('/api/invites/', {'email': 'invited@example.test'}, format='json')
        self.assertEqual(result.status_code, 201)
        self.assertIn('invite', result.data)

    def test_weak_password_and_invalid_invitation_rejected(self):
        for password, invitation in [('123', new_invite()), ('valid-but-no-invite-2026', 'not-real')]:
            result = Client().post('/api/account/register/', {'username': 'NewTest', 'email': 'test@example.test', 'password': password, 'invite': invitation}, content_type='application/json')
            self.assertEqual(result.status_code, 400)

    def test_password_reset_sends_mail_without_account_disclosure(self):
        with override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend'):
            client = Client()
            response = client.post('/accounts/password_reset/', {'email': 'a@example.test'})
            self.assertEqual(response.status_code, 302)
            self.assertEqual(len(mail.outbox), 1)
            self.assertIn('/accounts/reset/', mail.outbox[0].body)
            response = client.post('/accounts/password_reset/', {'email': 'unknown@example.test'})
            self.assertEqual(response.status_code, 302)
            self.assertEqual(len(mail.outbox), 1)

    def test_database_rate_limiter(self):
        limit('unit-test-limit', 1, 60)
        with self.assertRaises(Problem) as error:
            limit('unit-test-limit', 1, 60)
        self.assertEqual(error.exception.status_code, 429)

    def test_headers_index_health_and_revision(self):
        response = self.client.get('/')
        self.assertContains(response, 'name="family-api"')
        self.assertContains(response, '/static/collaboration.js')
        self.assertIn("frame-ancestors 'none'", response['Content-Security-Policy'])
        self.assertEqual(self.client.get('/healthz/').json(), {'status': 'ok'})
        before = self.client.get('/api/revision/').json()['revision']
        self.create_person()
        self.assertGreater(self.client.get('/api/revision/').json()['revision'], before)

    def test_editorial_export_includes_trash_and_no_passwords(self):
        output = io.StringIO()
        call_command('export_family', stdout=output)
        data = json.loads(output.getvalue())
        self.assertEqual(len(data['people']), 78)
        self.assertNotIn('password', data)
        self.assertEqual(data['format'], 'family-editorial-v1')

    def test_invalid_login_payload_is_a_validation_error(self):
        client = Client()
        response = client.post('/api/account/login/', {'username': 'ContributorA', 'password': {}}, content_type='application/json')
        self.assertEqual(response.status_code, 400)

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend', EMAIL_HOST='')
    def test_missing_smtp_is_reported_for_all_email_addresses(self):
        response = Client().post('/accounts/password_reset/', {'email': 'nobody@example.test'})
        self.assertEqual(response.status_code, 503)
        self.assertContains(response, 'not configured', status_code=503)

    def test_inactive_account_cannot_log_in(self):
        self.a.is_active = False; self.a.save()
        response = Client().post('/api/account/login/', {'username': self.a.username, 'password': 'family-test-password-only-2026'}, content_type='application/json')
        self.assertEqual(response.status_code, 400)

    def test_actual_bundled_video_decodes_locally(self):
        import shutil
        if not shutil.which('ffprobe'):
            self.skipTest('ffprobe is required for local video validation')
        video = SimpleUploadedFile('sample.mp4', (settings.BASE_DIR / 'dist/assets/dan-kole.mp4').read_bytes(), content_type='video/mp4')
        response = self.upload(file=video)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['kind'], 'video')

    def test_upload_cleanup_when_the_later_transaction_conflicts(self):
        before = Media.objects.count()
        with patch('family_api.views.save_record', side_effect=Problem('Concurrent change', 409)), patch('family_api.views.discard_upload') as cleanup:
            response = self.upload()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(Media.objects.count(), before)
        cleanup.assert_called_once()
