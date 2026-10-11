/**
 * Redaction tests. Allowlist serialization + entropy/digit masking +
 * Error handling, each with a masked (positive) AND a benign-passes (negative)
 * case.
 */
import { describe, expect, it } from 'vitest';
import { redactArgs, redactMessage } from './redact';

describe('redactMessage', () => {
  it('should_pass_a_benign_string_unchanged', () => {
    expect(redactMessage('Sync completed')).toBe('Sync completed');
  });

  it('should_mask_a_base64url_secret_blob_in_a_string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiwidHlwIjoiSldUI99999';
    const out = redactMessage(`token=${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[redacted]');
  });

  it('should_mask_a_long_digit_run_balance', () => {
    const out = redactMessage('balanceCents=123456789');
    expect(out).not.toContain('123456789');
    expect(out).toContain('[redacted]');
  });

  it('should_keep_only_allowlisted_object_keys', () => {
    const out = redactMessage({
      code: 'CURSOR_EXPIRED',
      balanceCents: 987654321,
      memberName: 'Jane Q. Public',
    });
    expect(out).toContain('CURSOR_EXPIRED');
    expect(out).not.toContain('Jane');
    expect(out).not.toContain('987654321');
  });
});

describe('redactArgs', () => {
  it('should_return_undefined_for_no_extra_args', () => {
    expect(redactArgs([])).toBeUndefined();
  });

  it('should_drop_a_secret_under_a_non_allowlisted_object_key', () => {
    const detail = redactArgs([{ refreshToken: 'abcdefghijklmnopqrstuvwxyz0123', code: 'X' }]);
    expect(detail).toContain('X');
    expect(detail).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('should_reduce_an_Error_to_name_plus_masked_message_dropping_own_props', () => {
    const err = new Error('failed for user 555123456 token AAAAAAAAAAAAAAAAAAAAAAAA');
    // Attach an enumerable own-prop carrying PII — must be dropped.
    (err as unknown as Record<string, unknown>).email = 'leak@example.com';
    const detail = redactArgs([err]);
    expect(detail).toContain('Error');
    expect(detail).not.toContain('leak@example.com');
    expect(detail).not.toContain('555123456');
    expect(detail).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('should_drop_a_generic_name_key_while_preserving_code_and_scenarioId', () => {
    // `name` on a plain-object arg is a member/account/scenario label (PII) and
    // is NOT allowlisted; code + scenarioId survive.
    const detail = redactArgs([{ name: 'Jane Public', code: 'X', scenarioId: 's1' }]);
    expect(detail).not.toContain('Jane Public');
    expect(detail).toContain('X');
    expect(detail).toContain('s1');
  });

  it('should_keep_an_Error_name_via_the_Error_path_not_the_object_allowlist', () => {
    // Dropping the generic `name` key must NOT lose Error names — `redactError`
    // captures `name` directly, independent of the object allowlist.
    const detail = redactArgs([new Error('boom')]);
    expect(detail).toContain('Error');
  });

  it('should_pass_a_benign_primitive_arg', () => {
    expect(redactArgs([42, true])).toContain('42');
  });

  it('should_drop_a_generic_reason_key_so_free_text_cannot_leak_via_diagnostics', () => {
    // `reason` is NOT allowlisted: an arbitrary object arg carrying prose/PII
    // under `reason` must be dropped (only high-entropy/long-digit strings are
    // masked, so free text would otherwise survive). The sync engine formats
    // its known rejection enum into a safe summary string itself, never relying
    // on this key surviving.
    const detail = redactArgs([
      { reason: 'declined by member Jane Q. Public', code: 'X' },
    ]);
    expect(detail).not.toContain('Jane Q. Public');
    expect(detail).toContain('X');
  });
});
