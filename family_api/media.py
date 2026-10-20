"""Validated uploads. New production media lives in Cloudinary, never on a dyno."""
import io
import json
import subprocess
import tempfile
import uuid
import warnings
from pathlib import Path
from django.conf import settings
from django.core.files.uploadhandler import FileUploadHandler, StopUpload
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework.exceptions import ValidationError
from .services import Problem


class UploadLimit(FileUploadHandler):
    def __init__(self, request=None):
        super().__init__(request)
        self.received = 0

    def receive_data_chunk(self, raw_data, start):
        self.received += len(raw_data)
        if self.received > settings.MAX_UPLOAD_BYTES:
            self.request.upload_too_large = True
            raise StopUpload(connection_reset=False)
        return raw_data

    def file_complete(self, file_size):
        return None


def validate_file(file):
    extension = Path(file.name).suffix.lower()
    if extension in {'.jpg', '.jpeg', '.png', '.webp'}:
        if file.size > settings.MAX_IMAGE_BYTES:
            raise ValidationError('Images must be 8 MB or smaller.')
        expected = {'.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP'}[extension]
        if file.content_type not in {'image/jpeg', 'image/png', 'image/webp'}:
            raise ValidationError('Choose a JPEG, PNG or WebP image.')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                image = Image.open(file)
                if image.format != expected or image.width * image.height > 20_000_000:
                    raise ValidationError('Unsupported or oversized image (maximum 20 megapixels).')
                image.load()
                image = ImageOps.exif_transpose(image)
                # Re-encode pixels only: discard EXIF/GPS, embedded thumbnails and arbitrary metadata.
                image = image.convert('RGB')
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=90, optimize=True)
                output.seek(0)
                return output, 'image', 'jpg'
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ValidationError('This image could not be decoded. Export a JPEG or PNG and try again.')
    if extension not in {'.mp4', '.mov'} or file.content_type not in {'video/mp4', 'video/quicktime'}:
        raise ValidationError('Use JPEG, PNG, WebP, MP4 or MOV. SVG, HTML and executables are not accepted.')
    if file.size > settings.MAX_VIDEO_BYTES:
        raise ValidationError('Videos must be 20 MB or smaller.')
    header = file.read(32)
    file.seek(0)
    if len(header) < 12 or header[4:8] != b'ftyp':
        raise ValidationError('This is not a supported MP4 or MOV container.')
    return file, 'video', extension[1:]


def store_upload(file):
    stream, kind, extension = validate_file(file)
    public_id = 'family-map/' + uuid.uuid4().hex
    if settings.MEDIA_BACKEND == 'cloudinary':
        if not settings.CLOUDINARY_URL:
            raise Problem('Media storage is not configured. Ask the maintainer to set CLOUDINARY_URL.', 503)
        import cloudinary
        import cloudinary.uploader
        from urllib.parse import urlparse
        config = urlparse(settings.CLOUDINARY_URL)
        if config.scheme != 'cloudinary' or not config.hostname or not config.username or not config.password:
            raise Problem('Cloudinary configuration is incomplete. Contact the maintainer.', 503)
        cloudinary.config(cloud_name=config.hostname, api_key=config.username, api_secret=config.password, secure=True)
        try:
            result = cloudinary.uploader.upload(stream, resource_type=kind, public_id=public_id,
                overwrite=False, unique_filename=False, timeout=20)
        except Exception:
            # Provider exceptions can include request configuration: do not return them to the browser.
            raise Problem('The media provider could not save this file. Please try again.', 503)
        upload = {'kind': kind, 'url': result.get('secure_url', ''), 'poster': '',
            'public_id': public_id, 'size': result.get('bytes', 0)}
        if result.get('resource_type') != kind or not upload['url'].startswith('https://res.cloudinary.com/') or result.get('bytes', 0) > settings.MAX_VIDEO_BYTES:
            discard_upload(upload)
            raise ValidationError('The media provider could not validate this upload.')
        if kind == 'video':
            if not 0 < result.get('duration', 0) <= 120 or not result.get('width') or not result.get('height'):
                discard_upload(upload)
                raise ValidationError('Choose a real video of up to two minutes, not an audio-only file.')
            from cloudinary.utils import cloudinary_url
            upload['poster'] = cloudinary_url(public_id, resource_type='video', format='jpg', secure=True)[0]
        return upload
    if not (settings.DEBUG or settings.TESTING):
        raise Problem('Local media storage is disabled in production.', 503)
    if kind == 'video':
        # Development uses the same real decoder requirement as the cloud provider.
        with tempfile.NamedTemporaryFile(suffix='.' + extension) as temp:
            for chunk in stream.chunks():
                temp.write(chunk)
            temp.flush()
            try:
                result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', temp.name],
                    capture_output=True, timeout=10, check=True)
                decoded = json.loads(result.stdout)
                if not any(s.get('codec_type') == 'video' for s in decoded.get('streams', [])) or not 0 < float(decoded['format']['duration']) <= 120:
                    raise ValueError('Invalid video')
            except FileNotFoundError:
                raise Problem('Install ffprobe for local video validation, or configure Cloudinary.', 503)
            except (ValueError, KeyError, subprocess.SubprocessError):
                raise ValidationError('The video could not be decoded or exceeds two minutes.')
        stream.seek(0)
    settings.MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    filename = public_id.split('/')[-1] + '.' + extension
    destination = settings.MEDIA_ROOT / filename
    with destination.open('xb') as target:
        if hasattr(stream, 'chunks'):
            for chunk in stream.chunks():
                target.write(chunk)
        else:
            target.write(stream.read())
    return {'kind': kind, 'url': settings.MEDIA_URL + filename, 'poster': '',
        'public_id': '', 'size': destination.stat().st_size}


def discard_upload(upload):
    """Only clean up a newly created asset whose database transaction failed."""
    if upload.get('public_id'):
        try:
            import cloudinary.uploader
            cloudinary.uploader.destroy(upload['public_id'], resource_type=upload['kind'], invalidate=True)
        except Exception:
            import logging
            logging.getLogger(__name__).warning('A failed upload needs orphan cleanup: %s', upload['public_id'])
    elif upload.get('url', '').startswith(settings.MEDIA_URL):
        path = settings.MEDIA_ROOT / Path(upload['url']).name
        path.unlink(missing_ok=True)
