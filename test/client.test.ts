import { describe, expect, it } from 'vitest';

import { buildUrl } from '../src/client.js';

describe('buildUrl', () => {
  it('serializes scalar and array query values', () => {
    const url = buildUrl('https://api.example.com', '/v1/interviews', {
      page: 2,
      tags: ['frontend', 'typescript'],
      active: true,
      ignored: undefined,
    });

    expect(url.toString()).toBe(
      'https://api.example.com/v1/interviews?page=2&tags=frontend&tags=typescript&active=true',
    );
  });
});