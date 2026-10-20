"""End-to-end editorial UI against a real disposable Django database and HTTP server.

Run separately after installing Playwright and Chromium. No production services are used.
"""
import io
import os
import tempfile
from pathlib import Path
from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.core.management import call_command
from django.test import override_settings
from playwright.sync_api import sync_playwright, expect
from PIL import Image
from family_api.auth import new_invite
from family_api.models import Person, Media


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
                person = Person.objects.get(name='Browser Updated Relative')
                self.assertEqual(person.version, 2)

                # A stale editor keeps its draft when another contributor saves first.
                page.locator('#map-search').fill('Browser Updated Relative')
                page.locator('.person-row').filter(has_text='Browser Updated Relative').click()
                page.get_by_role('button', name='Edit details', exact=True).click()
                dialog.get_by_label('Full name', exact=True).fill('Unsaved conflict draft')
                person.version += 1; person.save(update_fields=['version'])
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
                memory = Media.objects.get(caption='Browser test memory')
                self.assertEqual(list(memory.people.values_list('id', flat=True)), [person.id])

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
                person.refresh_from_db(); self.assertIsNotNone(person.deleted_at)
                page.get_by_role('button', name='Edit family', exact=True).click()
                dialog.get_by_role('button', name='Open Trash', exact=True).click()
                dialog.locator('.collab-record').filter(has_text='Browser Updated Relative').get_by_role('button', name='Restore', exact=True).click()
                expect(dialog.get_by_text('Browser Updated Relative', exact=True)).not_to_be_visible()
                person.refresh_from_db(); self.assertIsNone(person.deleted_at)
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
