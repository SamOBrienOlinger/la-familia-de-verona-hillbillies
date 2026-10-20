from datetime import date
import re
from rest_framework import serializers
from .models import Person, Relationship, Media, AuditEvent


class PersonSerializer(serializers.ModelSerializer):
    class Meta:
        model = Person
        fields = ['id', 'chart', 'name', 'aliases', 'lines', 'notes', 'generation', 'version', 'deleted_at', 'updated_at', 'source_snapshot']
        read_only_fields = ['id', 'version', 'deleted_at', 'updated_at', 'source_snapshot']

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('Enter a name.')
        return value.strip()

    def validate_aliases(self, value):
        return self.text_list(value, 20, 160)

    def validate_lines(self, value):
        lines = self.text_list(value, 20, 400)
        dates = {}
        for line in lines:
            match = re.match(r'^(Birth|Marriage|Death) (\d{1,2})/(\d{1,2})/(\d{4})(?:\s|$)', line)
            if match:
                try:
                    dates[match[1]] = date(int(match[4]), int(match[2]), int(match[3]))
                except ValueError:
                    raise serializers.ValidationError('Use a real calendar date in MM/DD/YYYY format, or retain an uncertain date as text.')
        if dates.get('Birth') and dates.get('Death') and dates['Birth'] > dates['Death']:
            raise serializers.ValidationError('The death date cannot be earlier than the birth date.')
        return lines

    @staticmethod
    def text_list(value, count, length):
        if not isinstance(value, list) or len(value) > count or any(not isinstance(s, str) or len(s) > length for s in value):
            raise serializers.ValidationError(f'Use at most {count} text entries, each up to {length} characters.')
        return list(dict.fromkeys(s.strip() for s in value if s.strip()))

    def validate_generation(self, value):
        if not 1 <= value <= 30:
            raise serializers.ValidationError('Generation must be from 1 to 30.')
        return value

    def validate(self, attrs):
        if self.instance and attrs.get('chart', self.instance.chart) != self.instance.chart:
            raise serializers.ValidationError('A source record cannot be moved between charts.')
        return attrs


class RelationshipSerializer(serializers.ModelSerializer):
    class Meta:
        model = Relationship
        fields = ['id', 'chart', 'source', 'target', 'kind', 'notes', 'version', 'deleted_at', 'source_snapshot']
        read_only_fields = ['id', 'version', 'deleted_at', 'source_snapshot']
        validators = []  # Validated with a chart lock in services, including on restore.


    def validate(self, attrs):
        if self.instance and attrs.get('chart', self.instance.chart) != self.instance.chart:
            raise serializers.ValidationError('A connection cannot be moved between source charts.')
        return attrs


class MediaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Media
        fields = ['id', 'people', 'kind', 'url', 'poster', 'caption', 'alt', 'credit', 'consent_confirmed', 'size', 'version', 'deleted_at', 'source_snapshot']
        read_only_fields = ['id', 'kind', 'url', 'poster', 'size', 'version', 'deleted_at', 'source_snapshot']

    def validate_people(self, people):
        if not 1 <= len(people) <= 20 or any(p.deleted_at for p in people):
            raise serializers.ValidationError('Select between 1 and 20 active people.')
        return list({p.pk: p for p in people}.values())

    def validate(self, attrs):
        if not attrs.get('consent_confirmed', self.instance.consent_confirmed if self.instance else False):
            raise serializers.ValidationError('Confirm that you have permission to share this media.')
        return attrs

    def validate_consent_confirmed(self, value):
        if value is not True:
            raise serializers.ValidationError('Confirm you have permission to share this media, including parental permission for children.')
        return value


class AuditSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuditEvent
        fields = ['id', 'actor_name', 'entity', 'object_id', 'action', 'before', 'after', 'created_at']
