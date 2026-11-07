import { describe, it, expect } from 'vitest';
import {
  isAcpSupported,
  buildAcpArgs,
  getAcpBinary,
  getAcpMode,
  getAcpBridgePackage,
} from './acp-provider-support.js';

describe('acp-provider-support', () => {
  // ===========================================================================
  // isAcpSupported
  // ===========================================================================
  describe('isAcpSupported', () => {
    it('returns true for gemini-cli', () => {
      expect(isAcpSupported('gemini-cli')).toBe(true);
    });

    it('returns true for claude-code (bridge mode)', () => {
      expect(isAcpSupported('claude-code')).toBe(true);
    });

    it('returns true for codex (bridge mode)', () => {
      expect(isAcpSupported('codex')).toBe(true);
    });

    it('returns false for custom providers', () => {
      expect(isAcpSupported({ id: 'custom', name: 'Custom', binary: 'foo' } as any)).toBe(false);
    });
  });

  // ===========================================================================
  // getAcpMode
  // ===========================================================================
  describe('getAcpMode', () => {
    it('returns native for gemini-cli', () => {
      expect(getAcpMode('gemini-cli')).toBe('native');
    });

    it('returns bridge for claude-code', () => {
      expect(getAcpMode('claude-code')).toBe('bridge');
    });

    it('returns bridge for codex', () => {
      expect(getAcpMode('codex')).toBe('bridge');
    });

    it('returns null for custom providers', () => {
      expect(getAcpMode({ id: 'custom' } as any)).toBeNull();
    });
  });

  // ===========================================================================
  // buildAcpArgs
  // ===========================================================================
  describe('buildAcpArgs', () => {
    it('returns --experimental-acp for gemini-cli', () => {
      const args = buildAcpArgs('gemini-cli');
      expect(args).toEqual(['--experimental-acp']);
    });

    it('includes --model when model option is provided for gemini-cli', () => {
      const args = buildAcpArgs('gemini-cli', { model: 'gemini-2.5-pro' });
      expect(args).toEqual(['--experimental-acp', '--model', 'gemini-2.5-pro']);
    });

    it('returns bridge args for claude-code', () => {
      const args = buildAcpArgs('claude-code');
      expect(args).toEqual(['acp-claude-code']);
    });

    it('includes --model for claude-code bridge', () => {
      const args = buildAcpArgs('claude-code', { model: 'claude-sonnet-4-6' });
      expect(args).toEqual(['acp-claude-code', '--model', 'claude-sonnet-4-6']);
    });

    it('returns bridge args for codex', () => {
      const args = buildAcpArgs('codex');
      expect(args).toEqual(['codex-acp']);
    });

    it('includes --model for codex bridge', () => {
      const args = buildAcpArgs('codex', { model: 'o3' });
      expect(args).toEqual(['codex-acp', '--model', 'o3']);
    });

    it('returns null for custom providers', () => {
      expect(buildAcpArgs({ id: 'custom' } as any)).toBeNull();
    });
  });

  // ===========================================================================
  // getAcpBinary
  // ===========================================================================
  describe('getAcpBinary', () => {
    it('maps claude-code to npx (bridge mode)', () => {
      expect(getAcpBinary('claude-code')).toBe('npx');
    });

    it('maps codex to npx (bridge mode)', () => {
      expect(getAcpBinary('codex')).toBe('npx');
    });

    it('maps gemini-cli to gemini (native mode)', () => {
      expect(getAcpBinary('gemini-cli')).toBe('gemini');
    });
  });

  // ===========================================================================
  // getAcpBridgePackage
  // ===========================================================================
  describe('getAcpBridgePackage', () => {
    it('returns acp-claude-code for claude-code', () => {
      expect(getAcpBridgePackage('claude-code')).toBe('acp-claude-code');
    });

    it('returns codex-acp for codex', () => {
      expect(getAcpBridgePackage('codex')).toBe('codex-acp');
    });

    it('returns null for gemini-cli (native mode)', () => {
      expect(getAcpBridgePackage('gemini-cli')).toBeNull();
    });

    it('returns null for custom providers', () => {
      expect(getAcpBridgePackage({ id: 'custom' } as any)).toBeNull();
    });
  });
});
