"""Shared editorial records; source snapshots never change through the API."""
import uuid
from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db.models.functions import Lower
from django.db import models
from django.db.models import Q, F


def new_id():
    return uuid.uuid4().hex


class User(AbstractUser):
    email = models.EmailField(unique=True)

    class Meta:
        constraints = [models.UniqueConstraint(Lower('email'), name='unique_email_case_insensitive')]


class Chart(models.Model):
    id = models.SlugField(primary_key=True)
    label = models.CharField(max_length=120)
    source_title = models.CharField(max_length=200)
    source_snapshot = models.JSONField(default=dict, editable=False)
    revision = models.PositiveIntegerField(default=1)


class Versioned(models.Model):
    id = models.CharField(primary_key=True, max_length=140, default=new_id, editable=False)
    version = models.PositiveIntegerField(default=1, editable=False)
    deleted_at = models.DateTimeField(null=True, blank=True, editable=False)
    delete_batch = models.UUIDField(null=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Person(Versioned):
    chart = models.ForeignKey(Chart, on_delete=models.PROTECT)
    name = models.CharField(max_length=160)
    aliases = models.JSONField(default=list)
    lines = models.JSONField(default=list)
    notes = models.TextField(blank=True, max_length=5000)
    generation = models.PositiveSmallIntegerField(default=1)
    source_y = models.FloatField(default=10000, editable=False)
    source_snapshot = models.JSONField(default=dict, editable=False)

    class Meta:
        ordering = ['name', 'id']
        constraints = [models.CheckConstraint(condition=Q(generation__gte=1) & Q(generation__lte=30), name='generation_range')]


class Relationship(Versioned):
    chart = models.ForeignKey(Chart, on_delete=models.PROTECT)
    source = models.ForeignKey(Person, on_delete=models.PROTECT, related_name='outgoing')
    target = models.ForeignKey(Person, on_delete=models.PROTECT, related_name='incoming')
    kind = models.CharField(max_length=12, choices=[('parent', 'Parent → child'), ('partner', 'Partners')])
    notes = models.CharField(max_length=500, blank=True)
    source_snapshot = models.JSONField(default=dict, editable=False)

    class Meta:
        ordering = ['id']
        constraints = [
            models.CheckConstraint(condition=~Q(source=F('target')), name='different_relatives'),
            models.UniqueConstraint(fields=['chart', 'source', 'target', 'kind'], condition=Q(deleted_at__isnull=True), name='active_relationship_unique'),
        ]


class Media(Versioned):
    people = models.ManyToManyField(Person, related_name='memories')
    kind = models.CharField(max_length=8, choices=[('image', 'Image'), ('video', 'Video')])
    url = models.CharField(max_length=1500)
    poster = models.CharField(max_length=1500, blank=True)
    public_id = models.CharField(max_length=250, blank=True, editable=False)
    caption = models.CharField(max_length=200)
    alt = models.CharField(max_length=300)
    credit = models.CharField(max_length=200, blank=True)
    size = models.PositiveIntegerField(default=0)
    consent_confirmed = models.BooleanField(default=False)
    source_snapshot = models.JSONField(default=dict, editable=False)

    class Meta:
        ordering = ['created_at', 'id']


class AuditEvent(models.Model):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    actor_name = models.CharField(max_length=150)
    entity = models.CharField(max_length=20)
    object_id = models.CharField(max_length=140)
    action = models.CharField(max_length=20)
    before = models.JSONField(default=dict)
    after = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-id']


class Invite(models.Model):
    token_hash = models.CharField(max_length=64, unique=True)
    email = models.EmailField(blank=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)


class RateBucket(models.Model):
    """Database-backed throttling works across dynos without a local-memory cache."""
    key = models.CharField(max_length=64, primary_key=True)
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField()
