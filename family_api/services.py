"""Transactional edits, immutable history, optimistic versions and graph validation."""
from collections import defaultdict, deque
from datetime import timedelta
import hashlib
import uuid
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, ValidationError
from .models import Chart, Person, Relationship, Media, AuditEvent, RateBucket
from .serializers import PersonSerializer, RelationshipSerializer, MediaSerializer


class Problem(APIException):
    def __init__(self, detail, status=400, **extra):
        self.status_code = status
        self.detail = {'detail': detail, **extra}


def limit(key, maximum, seconds=3600):
    now = timezone.now()
    digest = hashlib.sha256(key.encode()).hexdigest()
    with transaction.atomic():
        bucket, _ = RateBucket.objects.get_or_create(key=digest, defaults={'expires_at': now + timedelta(seconds=seconds)})
        bucket = RateBucket.objects.select_for_update().get(pk=bucket.pk)
        if now >= bucket.expires_at:
            bucket.count = 0
            bucket.expires_at = now + timedelta(seconds=seconds)
        if bucket.count >= maximum:
            raise Problem('Too many attempts. Please try again later.', 429, retry_after=max(1, int((bucket.expires_at - now).total_seconds())))
        bucket.count += 1
        bucket.save()


def lock_tree():
    # Lock a small, fixed set in a stable order. This also serializes cross-chart media edits.
    list(Chart.objects.order_by('id').select_for_update())


def version_check(request, obj):
    raw = request.headers.get('If-Match')
    if raw is None:
        raise Problem('Reload this record before changing it; an If-Match version is required.', 428)
    if raw.strip('"') != str(obj.version):
        raise Problem('Someone changed this record. Reload it and review your changes before saving again.', 409, current_version=obj.version)


def snapshot_record(obj):
    serializer = {Person: PersonSerializer, Relationship: RelationshipSerializer, Media: MediaSerializer}[type(obj)]
    return dict(serializer(obj).data)


def audit(actor, obj, action, before=None):
    AuditEvent.objects.create(actor=actor, actor_name=actor.get_username() if actor else 'Source import',
        entity=obj._meta.model_name, object_id=obj.pk, action=action,
        before=before or {}, after=snapshot_record(obj))
    # Monotonic per-chart versions let clients discover edits without sending names to analytics.
    from django.db.models import F
    Chart.objects.all().update(revision=F('revision') + 1)


def validate_graph(chart_id, proposed=None):
    people = {p.pk: p for p in Person.objects.filter(chart_id=chart_id, deleted_at=None)}
    edges = proposed if proposed is not None else list(Relationship.objects.filter(chart_id=chart_id, deleted_at=None))
    leaders = {key: key for key in people}

    def root(key):
        while leaders[key] != key:
            leaders[key] = leaders[leaders[key]]
            key = leaders[key]
        return key

    seen = set()
    for edge in edges:
        a, b = edge.source_id, edge.target_id
        if a == b or a not in people or b not in people:
            raise ValidationError('Connections must link two active people in the same chart.')
        identity = (edge.kind, *(sorted([a, b]) if edge.kind == 'partner' else [a, b]))
        if identity in seen:
            raise ValidationError('That connection already exists.')
        seen.add(identity)
        if edge.kind == 'partner':
            leaders[root(b)] = root(a)
    next_nodes = defaultdict(set)
    indegree = {root(p): 0 for p in people}
    generation = defaultdict(lambda: 1)
    for key, p in people.items():
        generation[root(key)] = max(generation[root(key)], p.generation)
    for edge in edges:
        if edge.kind != 'parent':
            continue
        a, b = root(edge.source_id), root(edge.target_id)
        if a == b:
            raise ValidationError('This would make someone both an ancestor and a partner in the same line.')
        if b not in next_nodes[a]:
            next_nodes[a].add(b)
            indegree[b] += 1
    queue = deque(sorted(key for key, value in indegree.items() if not value))
    processed = 0
    while queue:
        key = queue.popleft()
        processed += 1
        for child in sorted(next_nodes[key]):
            generation[child] = max(generation[child], generation[key] + 1)
            if generation[child] > 30:
                raise ValidationError('This connection exceeds the supported 30 generations.')
            indegree[child] -= 1
            if not indegree[child]:
                queue.append(child)
    if processed != len(indegree):
        raise ValidationError('This connection would create an ancestry cycle.')
    return {key: generation[root(key)] for key in people}, {key: root(key) for key in people}


def save_record(request, serializer, obj=None, extras=None):
    with transaction.atomic():
        lock_tree()
        if obj:
            obj = type(obj).objects.select_for_update().get(pk=obj.pk)
            version_check(request, obj)
            if obj.deleted_at:
                raise Problem('Restore this record before editing it.', 409)
            before = snapshot_record(obj)
            serializer.instance = obj
        else:
            before = None
        result = serializer.save(**{**(extras or {}), **({'version': obj.version + 1} if obj else {})})
        if isinstance(result, Relationship):
            # Re-read endpoints inside the transaction, not only during serializer validation.
            if result.source.chart_id != result.chart_id or result.target.chart_id != result.chart_id:
                raise ValidationError('Both people must belong to this chart.')
            if result.kind == 'partner' and result.source_id > result.target_id:
                result.source_id, result.target_id = result.target_id, result.source_id
                result.save()
        if isinstance(result, (Person, Relationship)):
            validate_graph(result.chart_id)
        if isinstance(result, Media) and (not result.people.exists() or result.people.filter(deleted_at__isnull=False).exists()):
            raise ValidationError('A memory must be linked only to active people.')
        audit(request.user, result, 'update' if obj else 'create', before)
        return result


def trash_record(request, obj):
    with transaction.atomic():
        lock_tree()
        obj = type(obj).objects.select_for_update().get(pk=obj.pk)
        version_check(request, obj)
        if obj.deleted_at:
            raise Problem('This record is already in Trash.', 409)
        batch = uuid.uuid4()
        items = [obj]
        if isinstance(obj, Person):
            from django.db.models import Q
            items += list(Relationship.objects.filter(Q(source=obj) | Q(target=obj), deleted_at=None))
        for item in items:
            before = snapshot_record(item)
            item.deleted_at = timezone.now()
            item.delete_batch = batch
            item.version += 1
            item.save()
            audit(request.user, item, 'delete', before)
        return snapshot_record(obj)


def restore_record(request, obj):
    with transaction.atomic():
        lock_tree()
        obj = type(obj).objects.select_for_update().get(pk=obj.pk)
        version_check(request, obj)
        if not obj.deleted_at:
            raise Problem('This record is not in Trash.', 409)
        before = snapshot_record(obj)
        if isinstance(obj, Media) and not obj.people.filter(deleted_at=None).exists():
            raise ValidationError('Restore a person linked to this memory first.')
        obj.deleted_at = None
        obj.version += 1
        obj.save()
        if isinstance(obj, (Person, Relationship)):
            validate_graph(obj.chart_id)
        audit(request.user, obj, 'restore', before)
        # Relationships are deliberately restored individually, with fresh cycle/dependency checks.
        return snapshot_record(obj)


def make_snapshot():
    family = {'charts': [], 'mediaGroups': {}, 'collaborative': True}
    graphs = {'version': 2, 'provenance': {'method': 'Source records with audited family edits', 'sourceChartsKeptSeparate': True}, 'charts': {}}
    media_by_person = defaultdict(list)
    for media in Media.objects.filter(deleted_at=None).order_by('-updated_at', 'id').prefetch_related('people'):
        active = [p for p in media.people.all() if not p.deleted_at]
        if not active:
            continue
        family['mediaGroups'][media.pk] = {'type': media.kind, 'src': media.url, 'poster': media.poster,
            'caption': media.caption, 'alt': media.alt, 'names': [p.name for p in active], 'credit': media.credit}
        for p in active:
            media_by_person[p.pk].append(media.pk)
    for c in Chart.objects.order_by('-id'):
        generation, components = validate_graph(c.pk)
        people = list(Person.objects.filter(chart=c, deleted_at=None))
        chart = {'id': c.pk, 'label': c.label, 'sourceTitle': c.source_title, 'revision': c.revision,
            'image': f'assets/{c.pk}-tree.svg', 'people': []}
        for person in people:
            row = snapshot_record(person)
            row.update(mediaGroup=next(iter(media_by_person[person.pk]), None), mediaLabel=person.name,
                mediaIds=media_by_person[person.pk], generation=generation[person.pk])
            chart['people'].append(row)
        edges = list(Relationship.objects.filter(chart=c, deleted_at=None))
        parents = defaultdict(list)
        for edge in edges:
            if edge.kind == 'parent':
                parents[edge.target_id].append(edge.source_id)
        families = {}

        def family_for(ids):
            ids = sorted(ids)
            key = 'family-' + hashlib.sha256(('|'.join(ids)).encode()).hexdigest()[:20]
            families.setdefault(key, {'id': key, 'parents': ids, 'children': []})
            return key

        child_families = {}
        for child, ids in parents.items():
            fid = family_for(ids)
            families[fid]['children'].append(child)
            child_families[child] = fid
        graph_edges = []
        for edge in edges:
            fid = child_families[edge.target_id] if edge.kind == 'parent' else family_for([edge.source_id, edge.target_id])
            graph_edges.append({'id': edge.pk, 'source': edge.source_id, 'target': edge.target_id, 'type': edge.kind, 'familyId': fid})
        grouped = defaultdict(list)
        for p in people:
            grouped[components[p.pk]].append(p)
        ordered_components = sorted(grouped.values(), key=lambda group: (min(p.source_y for p in group), min(p.pk for p in group)))
        rows = defaultdict(int)
        nodes = []
        for group in ordered_components:
            for p in sorted(group, key=lambda p: (p.source_y, p.pk)):
                g = generation[p.pk]
                nodes.append({'id': p.pk, 'generation': g, 'x': 265.429 + (g - 1) * 400, 'y': 160 + rows[g] * 75})
                rows[g] += 1
        gens = [{'index': g, 'label': f'Generation {g}', 'x': 265.429 + (g - 1) * 400, 'count': rows[g]} for g in sorted(rows)]
        graphs['charts'][c.pk] = {'id': c.pk, 'label': c.label, 'rootId': nodes[0]['id'] if nodes else None,
            'nodes': nodes, 'generations': gens, 'families': list(families.values()), 'edges': graph_edges}
        family['charts'].append(chart)
    return {'data': family, 'graph': graphs, 'revision': sum(c.revision for c in Chart.objects.all())}
