/** @vitest-environment jsdom */

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ImageWithFallback from './image.with.fallback';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('ImageWithFallback', () => {
  it('shows the fallback when the original image fails to load', () => {
    const { getByAltText } = render(
      <ImageWithFallback
        src="https://example.com/missing-avatar.jpg"
        fallbackSrc="/no-picture.jpg"
        alt="Channel avatar"
        width={36}
        height={36}
      />
    );

    const image = getByAltText('Channel avatar');
    fireEvent.error(image);

    expect(image.getAttribute('src')).toBe('/no-picture.jpg');
  });
});
