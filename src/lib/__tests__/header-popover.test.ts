import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceHeaderPopover, subscribeHeaderPopover } from '../header-popover';

class TestCustomEvent<T> extends Event {
  readonly detail: T;

  constructor(type: string, init: CustomEventInit<T>) {
    super(type);
    this.detail = init.detail as T;
  }
}

describe('exclusive header popovers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('closes other controls while keeping the announced control open', () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    const closeMode = vi.fn();
    const closeAgent = vi.fn();
    const closeModel = vi.fn();
    const unsubscribeMode = subscribeHeaderPopover('mode', closeMode);
    const unsubscribeAgent = subscribeHeaderPopover('agent', closeAgent);
    const unsubscribeModel = subscribeHeaderPopover('model', closeModel);

    announceHeaderPopover('mode');
    expect(closeMode).not.toHaveBeenCalled();
    expect(closeAgent).toHaveBeenCalledTimes(1);
    expect(closeModel).toHaveBeenCalledTimes(1);

    announceHeaderPopover('model');
    expect(closeMode).toHaveBeenCalledTimes(1);
    expect(closeAgent).toHaveBeenCalledTimes(2);
    expect(closeModel).toHaveBeenCalledTimes(1);

    unsubscribeMode();
    unsubscribeAgent();
    unsubscribeModel();
  });
});
