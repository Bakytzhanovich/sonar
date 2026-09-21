import { describe, it, expect } from 'vitest';
import { asRole, canPerform, isRole, requiredRole, ROLE_LABELS, ROLES } from '../src/roles';

describe('requiredRole', () => {
  it('lets anyone signed in read', () => {
    expect(requiredRole('GET', '/api/bots')).toBe('viewer');
    expect(requiredRole('HEAD', '/api/video-edit-jobs')).toBe('viewer');
  });

  it('treats every other method as a write', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredRole(method, '/api/bots'), method).toBe('editor');
    }
  });

  it('covers a route nobody has written yet', () => {
    // The point of deciding by method rather than by annotation: the rule
    // applies to routes that do not exist at the time it is written, so
    // forgetting to mark one cannot leave it open.
    expect(requiredRole('POST', '/api/something-invented-next-year')).toBe('editor');
    expect(requiredRole('GET', '/api/something-invented-next-year')).toBe('viewer');
  });

  it('reserves managing people for the owner, whatever the method', () => {
    // An editor who can invite is an editor who can promote themselves, and
    // then the roles stop meaning anything.
    expect(requiredRole('GET', '/api/members')).toBe('owner');
    expect(requiredRole('POST', '/api/members')).toBe('owner');
    expect(requiredRole('DELETE', '/api/members/u1')).toBe('owner');
  });

  it('lets a viewer change what belongs only to them', () => {
    // Refusing these protects nothing — the data is theirs — and makes the
    // read-only role feel broken rather than limited.
    expect(requiredRole('POST', '/api/push/subscribe')).toBe('viewer');
    expect(requiredRole('POST', '/api/notifications/read-all')).toBe('viewer');
    expect(requiredRole('POST', '/api/notifications/abc-123/read')).toBe('viewer');
  });

  it('does not let a lookalike path slip through the self-scoped list', () => {
    expect(requiredRole('POST', '/api/notifications/abc/read/extra')).toBe('editor');
    expect(requiredRole('POST', '/api/push/subscribe/all')).toBe('editor');
  });
});

describe('canPerform', () => {
  it('ranks the roles so each can do everything the weaker one can', () => {
    expect(canPerform('owner', 'POST', '/api/members')).toBe(true);
    expect(canPerform('owner', 'POST', '/api/bots')).toBe(true);
    expect(canPerform('owner', 'GET', '/api/bots')).toBe(true);

    expect(canPerform('editor', 'POST', '/api/members')).toBe(false);
    expect(canPerform('editor', 'POST', '/api/bots')).toBe(true);
    expect(canPerform('editor', 'GET', '/api/bots')).toBe(true);

    expect(canPerform('viewer', 'POST', '/api/members')).toBe(false);
    expect(canPerform('viewer', 'POST', '/api/bots')).toBe(false);
    expect(canPerform('viewer', 'GET', '/api/bots')).toBe(true);
  });
});

describe('asRole', () => {
  it.each([[null], [undefined], ['admin'], [7], ['OWNER']])(
    'treats %s as the weakest role, never the strongest',
    (value) => {
      // This value arrives from a database column. A row written by an older
      // version, or by hand, must not be able to read as more than it is.
      expect(asRole(value)).toBe('viewer');
    }
  );

  it('passes a real role through', () => {
    for (const role of ROLES) expect(asRole(role)).toBe(role);
  });
});

describe('isRole', () => {
  it('accepts only the three', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole('')).toBe(false);
  });
});

describe('ROLE_LABELS', () => {
  it('names every role, so a refusal can say which one is needed', () => {
    for (const role of ROLES) expect(ROLE_LABELS[role]).toBeTruthy();
  });
});
