from django.contrib import admin
from .models import Chart, Person, Relationship, Media, AuditEvent


class ReadOnlyAdmin(admin.ModelAdmin):
    """Content edits use the API so validation, history and versions cannot be bypassed."""
    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return False


for model in (Chart, Person, Relationship, Media, AuditEvent):
    admin.site.register(model, ReadOnlyAdmin)

from django.contrib.auth.admin import UserAdmin
from .models import User
admin.site.register(User, UserAdmin)
