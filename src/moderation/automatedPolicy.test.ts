import { deepEqual, equal } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moderateAutomatically } from './automatedPolicy';

describe('automated moderation policy', () => {
  it('allows ordinary conversation text', () => {
    deepEqual(moderateAutomatically('Can we meet after work?'), {
      action: 'allow', content: 'Can we meet after work?'
    });
  });

  it('blocks explicit threats before delivery', () => {
    const result = moderateAutomatically('I will hurt you.');
    equal(result.action, 'block');
    if (result.action === 'block') equal(result.content, '');
  });

  it('redacts credential-like values before persistence', () => {
    const result = moderateAutomatically('password=secret123');
    equal(result.action, 'redact');
    if (result.action === 'redact') equal(result.content, 'password=[REDACTED]');
  });
});