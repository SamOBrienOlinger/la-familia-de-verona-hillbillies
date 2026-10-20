"""End-to-end editorial UI against a real disposable Django database and HTTP server.

Run separately after installing Playwright and Chromium. No production services are used.
"""
import io
import os
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from django.db import connections, close_old_connections
from django.db.models import F
from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.core.management import call_command
from django.test import override_settings
from playwright.sync_api import sync_playwright, expect
from PIL import Image
from family_api.auth import new_invite
from family_api.models import Person, Media


def database_call(operation):
    """Playwright's sync wrapper still owns an event loop; isolate synchronous ORM work."""
    def run():
        close_old_connections()
        try:
            return operation()
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as worker:
        return worker.submit(run).result(timeout=15)


@override_settings(DEBUG=True, MEDIA_BACKEND='local')
class EditorialBrowserTests(StaticLiveServerTestCase):
    def test_shared_editorial_journey_desktop_and_mobile(self):
        call_command('import_family', stdout=io.StringIO())
        password = 'Only-for-isolated-browser-tests-2026'
        maintainer = get_user_model().objects.create_user(username='MaintainerTest', email='maintainer@example.test', password=password, is_staff=True)
        token = new_invite(maintainer, 'browser@example.test')
        errors = []
        out = Path('test-results'); out.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)), sync_playwright() as p:
            executable = os.environ.get('BROWSER_EXECUTABLE')
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}))
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(self.live_server_url)
                expect(page.get_by_text('Connected to the shared family record.', exact=True)).to_be_visible()
                page.get_by_role('button', name='Contribute', exact=True).click()
                dialog = page.locator('#contributor-dialog')
                dialog.get_by_role('button', name='Have an invitation? Join the family', exact=True).click()
                dialog.get_by_label('Username', exact=True).fill('BrowserContributor')
                dialog.get_by_label('Email address', exact=True).fill('browser@example.test')
                dialog.get_by_label('Password (at least 12 characters)', exact=True).fill(password)
                dialog.get_by_label('Invitation code', exact=True).fill(token)
                dialog.get_by_role('button', name='Create account', exact=True).click()
                expect(dialog).not_to_be_visible()
                expect(page.get_by_role('button', name='Edit family', exact=True)).to_be_visible()

                page.get_by_role('button', name='Edit family', exact=True).click()
                dialog.get_by_role('button', name='Add a person', exact=True).click()
                dialog.get_by_label('Full name', exact=True).fill('Browser Example Relative')
                dialog.get_by_label('Notes', exact=True).fill('A fictional record used only in automated tests.')
                dialog.get_by_role('button', name='Save person', exact=True).click()
                expect(dialog).not_to_be_visible()
                page.locator('#map-search').fill('Browser Example Relative')
                page.locator('.person-row').filter(has_text='Browser Example Relative').click()
                expect(page.get_by_role('button', name='Edit details', exact=True)).to_be_visible()
                page.get_by_role('button', name='Edit details', exact=True).click()
                expect(dialog.get_by_label('Full name', exact=True)).to_have_value('Browser Example Relative')
                dialog.get_by_label('Full name', exact=True).fill('Browser Updated Relative')
                dialog.get_by_role('button', name='Save person', exact=True).click()
                expect(dialog).not_to_be_visible()
                person = database_call(lambda: Person.objects.values('id', 'version').get(name='Browser Updated Relative'))
                person_id = person['id']
                self.assertEqual(person['version'], 2)

                # A stale editor keeps its draft when another contributor saves first.
                page.locator('#map-search').fill('Browser Updated Relative')
                page.locator('.person-row').filter(has_text='Browser Updated Relative').click()
                page.get_by_role('button', name='Edit details', exact=True).click()
                dialog.get_by_label('Full name', exact=True).fill('Unsaved conflict draft')
                database_call(lambda: Person.objects.filter(pk=person_id).update(version=F('version') + 1))
                dialog.get_by_role('button', name='Save person', exact=True).click()
                expect(dialog.locator('#contributor-error')).to_contain_text('Someone changed this record')
                expect(dialog.get_by_label('Full name', exact=True)).to_have_value('Unsaved conflict draft')
                dialog.get_by_role('button', name='Close', exact=True).click()
                dialog.get_by_role('button', name='Discard changes', exact=True).click()

                # Upload real image through the file input, then verify durable API association.
                page.get_by_role('button', name='Manage memories', exact=True).click()
                dialog.get_by_role('button', name='Upload another memory', exact=True).click()
                dialog.get_by_label('Caption', exact=True).fill('Browser test memory')
                dialog.get_by_label('Image description / video description', exact=True).fill('A generated plain test image, not a real relative.')
                photo = Path(directory) / 'input.jpg'; Image.new('RGB', (32, 40), 'white').save(photo)
                dialog.get_by_label('Choose a file', exact=True).set_input_files(str(photo))
                dialog.locator('input[name="consent_confirmed"]').check()
                dialog.get_by_role('button', name='Upload memory', exact=True).click()
                expect(dialog).not_to_be_visible()
                associated = database_call(lambda: list(Media.objects.get(caption='Browser test memory').people.values_list('id', flat=True)))
                self.assertEqual(associated, [person_id])
                expect(page.locator('.profile-photo-button img')).to_be_visible()
                page.wait_for_function("() => { const img = document.querySelector('.profile-photo-button img'); return img && img.complete && img.naturalWidth > 0; }")

                for width, height in [(1440, 900), (390, 844), (320, 568)]:
                    page.set_viewport_size({'width': width, 'height': height})
                    page.get_by_role('button', name='Edit family', exact=True).click()
                    dialog.get_by_role('button', name='Add a person', exact=True).click()
                    expect(dialog.get_by_label('Full name', exact=True)).to_be_visible()
                    self.assertLessEqual(dialog.bounding_box()['width'], width)
                    page.screenshot(path=str(out / ('collaborative-editor-%s.png' % width)))
                    dialog.get_by_role('button', name='Close', exact=True).click()

                page.set_viewport_size({'width': 1440, 'height': 900})
                page.get_by_role('button', name='Move person to Trash', exact=True).click()
                dialog.get_by_role('button', name='Move to Trash', exact=True).click()
                expect(dialog).not_to_be_visible()
                self.assertIsNotNone(database_call(lambda: Person.objects.values_list('deleted_at', flat=True).get(pk=person_id)))
                page.get_by_role('button', name='Edit family', exact=True).click()
                dialog.get_by_role('button', name='Open Trash', exact=True).click()
                dialog.locator('.collab-record').filter(has_text='Browser Updated Relative').get_by_role('button', name='Restore', exact=True).click()
                expect(dialog.get_by_text('Browser Updated Relative', exact=True)).not_to_be_visible()
                self.assertIsNone(database_call(lambda: Person.objects.values_list('deleted_at', flat=True).get(pk=person_id)))
                dialog.get_by_role('button', name='Close', exact=True).click()
                page.get_by_role('button', name='Edit family', exact=True).click()
                dialog.get_by_role('button', name='Change history', exact=True).click()
                expect(dialog.locator('summary').first).to_contain_text('BrowserContributor')
                dialog.get_by_role('button', name='Close', exact=True).click()
                page.get_by_role('button', name='Edit family', exact=True).click()
                dialog.get_by_role('button', name='Sign out', exact=True).click()
                expect(page.get_by_role('button', name='Contribute', exact=True)).to_be_visible()
                self.assertEqual(errors, [])
            finally:
                page.screenshot(path=str(out / 'collaborative-last-screen.png'))
                browser.close()
