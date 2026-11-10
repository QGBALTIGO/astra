// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerAvatar } from './components';
import { testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
beforeEach(() => {
  dom = testDom();
});
afterEach(async () => {
  await dom.cleanup();
});

describe('customer photo with initials', () => {
  it.each([
    ['Marina', 'M'],
    ['  João   da Silva  ', 'JS'],
    ['Ágata Costa', 'ÁC'],
    ['', '?'],
  ])('shows stable initials for %s without a photo', async (name, initials) => {
    await dom.render(<CustomerAvatar displayName={name} url={null} />);
    expect(dom.container.textContent).toBe(initials);
    expect(dom.container.querySelector('img')).toBeNull();
  });

  it('shows initials until the image loads and after decoding errors', async () => {
    await dom.render(<CustomerAvatar displayName="Ana Martins" url="blob:photo" />);
    expect(dom.container.querySelector('.ac-avatar')?.classList.contains('is-loaded')).toBe(false);
    const image = dom.container.querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('');
    expect(image.width).toBe(40);
    expect(image.height).toBe(40);
    await act(async () => image.dispatchEvent(new Event('load')));
    expect(dom.container.querySelector('.ac-avatar')?.classList.contains('is-loaded')).toBe(true);
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(dom.container.querySelector('img')).toBeNull();
    expect(dom.container.querySelector('.ac-avatar')?.classList.contains('is-loaded')).toBe(false);
    expect(dom.container.textContent).toBe('AM');
  });

  it('does not show an old decoded photo when the URL or identity changes', async () => {
    await dom.render(<CustomerAvatar displayName="Ana Martins" url="blob:previous" />);
    const previous = dom.container.querySelector('img')!;
    await act(async () => previous.dispatchEvent(new Event('load')));
    await dom.render(<CustomerAvatar displayName="Bruno Costa" url={null} />);
    expect(dom.container.querySelector('img')).toBeNull();
    expect(dom.container.textContent).toBe('BC');
    await dom.render(<CustomerAvatar displayName="Bruno Costa" url="blob:current" />);
    expect(dom.container.querySelector('.ac-avatar')?.classList.contains('is-loaded')).toBe(false);
    expect(dom.container.querySelector('img')?.getAttribute('src')).toBe('blob:current');
  });
});
