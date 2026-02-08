/**
 * File URL Fallback Tests
 *
 * Verifies that synthesized WebSocket file URLs are correctly parsed by
 * extractFileKey() and extractFigmaUrlInfo() — the same functions used
 * by all REST API tools to resolve file keys from URLs.
 *
 * The synthesized URL format matches what getCurrentFileUrl() produces
 * when only WebSocket file identity is available (no CDP browser):
 *   https://www.figma.com/design/{fileKey}/{encodeURIComponent(fileName)}
 */

import { extractFileKey, extractFigmaUrlInfo } from '../src/core/figma-api';

describe('Synthesized WebSocket URL parsing', () => {
  describe('extractFileKey()', () => {
    test('parses fileKey from synthesized WebSocket URL', () => {
      const url = 'https://www.figma.com/design/abc123XYZ/My%20Design%20File';
      expect(extractFileKey(url)).toBe('abc123XYZ');
    });

    test('parses fileKey with Untitled fallback name', () => {
      const url = 'https://www.figma.com/design/def456/Untitled';
      expect(extractFileKey(url)).toBe('def456');
    });

    test('parses fileKey with special characters in fileName', () => {
      const url = 'https://www.figma.com/design/ghi789/' + encodeURIComponent('Eddie™ Design — v2.0 (Final)');
      expect(extractFileKey(url)).toBe('ghi789');
    });

    test('parses fileKey with unicode characters in fileName', () => {
      const url = 'https://www.figma.com/design/jkl012/' + encodeURIComponent('デザインシステム');
      expect(extractFileKey(url)).toBe('jkl012');
    });

    test('parses fileKey with empty fileName segment', () => {
      // Edge case: encodeURIComponent('') produces ''
      const url = 'https://www.figma.com/design/mno345/';
      expect(extractFileKey(url)).toBe('mno345');
    });
  });

  describe('extractFigmaUrlInfo()', () => {
    test('parses synthesized WebSocket URL correctly', () => {
      const url = 'https://www.figma.com/design/abc123XYZ/My%20Design%20File';
      const info = extractFigmaUrlInfo(url);
      expect(info).not.toBeNull();
      expect(info!.fileKey).toBe('abc123XYZ');
      expect(info!.branchId).toBeUndefined();
      expect(info!.nodeId).toBeUndefined();
    });

    test('synthesized URL has no branch or node info', () => {
      const url = 'https://www.figma.com/design/xyz789/Untitled';
      const info = extractFigmaUrlInfo(url);
      expect(info).not.toBeNull();
      expect(info!.fileKey).toBe('xyz789');
      expect(info!.branchId).toBeUndefined();
      expect(info!.nodeId).toBeUndefined();
    });

    test('works with /file/ path format too', () => {
      // Ensure backward compatibility — extractFigmaUrlInfo supports both /design/ and /file/
      const url = 'https://www.figma.com/file/abc123/My%20File';
      const info = extractFigmaUrlInfo(url);
      expect(info).not.toBeNull();
      expect(info!.fileKey).toBe('abc123');
    });
  });

  describe('URL synthesis format', () => {
    /**
     * These tests verify that the URL format produced by getCurrentFileUrl()
     * in src/local.ts is compatible with the parsing functions.
     */

    test('encodeURIComponent preserves fileKey parsing', () => {
      // Simulate what getCurrentFileUrl() does
      const fileKey = 'abc123XYZ';
      const fileName = 'Eddie™ Design — v2.0 (Final)';
      const synthesized = `https://www.figma.com/design/${fileKey}/${encodeURIComponent(fileName)}`;

      expect(extractFileKey(synthesized)).toBe(fileKey);
      const info = extractFigmaUrlInfo(synthesized);
      expect(info).not.toBeNull();
      expect(info!.fileKey).toBe(fileKey);
    });

    test('Untitled fallback works', () => {
      const fileKey = 'def456';
      const synthesized = `https://www.figma.com/design/${fileKey}/${encodeURIComponent('Untitled')}`;

      expect(extractFileKey(synthesized)).toBe(fileKey);
    });

    test('null/undefined fileName gets Untitled fallback', () => {
      // Simulate: wsFileInfo.fileName is undefined or empty
      const fileKey = 'ghi789';
      const fileName: string | undefined = undefined;
      const synthesized = `https://www.figma.com/design/${fileKey}/${encodeURIComponent(fileName || 'Untitled')}`;

      expect(extractFileKey(synthesized)).toBe(fileKey);
    });
  });
});
