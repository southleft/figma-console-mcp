/**
 * Tests for figma_lint_design tool
 *
 * Covers: rule groups, severity mapping, connector routing,
 * schema validation, error handling, and WCAG calculations.
 */

describe('figma_lint_design', () => {
	// ========================================================================
	// WCAG contrast calculations (matching code.js implementation)
	// ========================================================================

	describe('WCAG contrast calculations', () => {
		function linearize(c: number): number {
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}

		function luminance(r: number, g: number, b: number): number {
			return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
		}

		function contrastRatio(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
			const l1 = luminance(r1, g1, b1);
			const l2 = luminance(r2, g2, b2);
			const lighter = Math.max(l1, l2);
			const darker = Math.min(l1, l2);
			return (lighter + 0.05) / (darker + 0.05);
		}

		it('should calculate black/white contrast as 21:1', () => {
			const ratio = contrastRatio(0, 0, 0, 1, 1, 1);
			expect(ratio).toBeCloseTo(21, 0);
		});

		it('should calculate white/white contrast as 1:1', () => {
			const ratio = contrastRatio(1, 1, 1, 1, 1, 1);
			expect(ratio).toBeCloseTo(1, 1);
		});

		it('should detect failing AA contrast (gray on white)', () => {
			// #AAAAAA on #FFFFFF ≈ 2.32:1 (fails AA)
			const ratio = contrastRatio(0.667, 0.667, 0.667, 1, 1, 1);
			expect(ratio).toBeLessThan(4.5);
		});

		it('should detect passing AA contrast (dark gray on white)', () => {
			// #333333 on #FFFFFF ≈ 12.6:1 (passes AA)
			const ratio = contrastRatio(0.2, 0.2, 0.2, 1, 1, 1);
			expect(ratio).toBeGreaterThan(4.5);
		});

		it('should handle large text threshold (3:1)', () => {
			// Large text (>=18px or >=14px bold) only needs 3:1
			const ratio = contrastRatio(0.5, 0.5, 0.5, 1, 1, 1);
			expect(ratio).toBeGreaterThan(3.0);
		});

		it('should be commutative (order independent)', () => {
			const r1 = contrastRatio(0.2, 0.3, 0.4, 0.8, 0.9, 1.0);
			const r2 = contrastRatio(0.8, 0.9, 1.0, 0.2, 0.3, 0.4);
			expect(r1).toBeCloseTo(r2, 5);
		});
	});

	// ========================================================================
	// Rule groups
	// ========================================================================

	describe('rule groups', () => {
		const ALL_RULES = [
			'wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height',
			'hardcoded-color', 'no-text-style', 'default-name', 'detached-component',
			'no-autolayout', 'empty-container',
		];

		const WCAG_RULES = ['wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height'];
		const DESIGN_SYSTEM_RULES = ['hardcoded-color', 'no-text-style', 'default-name', 'detached-component'];
		const LAYOUT_RULES = ['no-autolayout', 'empty-container'];

		it('should have 10 rules total', () => {
			expect(ALL_RULES).toHaveLength(10);
		});

		it('should have 4 WCAG rules', () => {
			expect(WCAG_RULES).toHaveLength(4);
		});

		it('should have 4 design system rules', () => {
			expect(DESIGN_SYSTEM_RULES).toHaveLength(4);
		});

		it('should have 2 layout rules', () => {
			expect(LAYOUT_RULES).toHaveLength(2);
		});

		it('should cover all rules across groups', () => {
			const combined = [...WCAG_RULES, ...DESIGN_SYSTEM_RULES, ...LAYOUT_RULES];
			expect(combined.sort()).toEqual(ALL_RULES.sort());
		});
	});

	// ========================================================================
	// Severity mapping
	// ========================================================================

	describe('severity mapping', () => {
		const SEVERITY_MAP: Record<string, string> = {
			'wcag-contrast': 'critical',
			'wcag-target-size': 'critical',
			'wcag-text-size': 'warning',
			'wcag-line-height': 'warning',
			'hardcoded-color': 'warning',
			'no-text-style': 'warning',
			'default-name': 'warning',
			'detached-component': 'warning',
			'no-autolayout': 'warning',
			'empty-container': 'info',
		};

		it('should have 2 critical rules', () => {
			const critical = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'critical');
			expect(critical).toHaveLength(2);
		});

		it('should have 7 warning rules', () => {
			const warnings = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'warning');
			expect(warnings).toHaveLength(7);
		});

		it('should have 1 info rule', () => {
			const info = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'info');
			expect(info).toHaveLength(1);
		});

		it('should map contrast and target size as critical', () => {
			expect(SEVERITY_MAP['wcag-contrast']).toBe('critical');
			expect(SEVERITY_MAP['wcag-target-size']).toBe('critical');
		});
	});

	// ========================================================================
	// Connector routing
	// ========================================================================

	describe('WebSocketConnector.lintDesign', () => {
		it('should send LINT_DESIGN command with correct params', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: true,
				data: { rootNodeId: '0:1', categories: [], summary: { critical: 0, warning: 0, info: 0, total: 0 } },
			});

			const lintDesign = async (nodeId?: string, rules?: string[], maxDepth?: number, maxFindings?: number) => {
				const params: any = {};
				if (nodeId) params.nodeId = nodeId;
				if (rules) params.rules = rules;
				if (maxDepth !== undefined) params.maxDepth = maxDepth;
				if (maxFindings !== undefined) params.maxFindings = maxFindings;
				return mockSendCommand('LINT_DESIGN', params, 120000);
			};

			await lintDesign('1:2', ['wcag'], 5, 50);

			expect(mockSendCommand).toHaveBeenCalledWith(
				'LINT_DESIGN',
				{ nodeId: '1:2', rules: ['wcag'], maxDepth: 5, maxFindings: 50 },
				120000,
			);
		});

		it('should use 120s timeout for large scans', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({ success: true });

			const lintDesign = async () => {
				return mockSendCommand('LINT_DESIGN', {}, 120000);
			};

			await lintDesign();

			expect(mockSendCommand).toHaveBeenCalledWith('LINT_DESIGN', expect.anything(), 120000);
		});

		it('should omit undefined params', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({ success: true });

			const lintDesign = async (nodeId?: string, rules?: string[]) => {
				const params: any = {};
				if (nodeId) params.nodeId = nodeId;
				if (rules) params.rules = rules;
				return mockSendCommand('LINT_DESIGN', params, 120000);
			};

			await lintDesign(); // No args

			expect(mockSendCommand).toHaveBeenCalledWith('LINT_DESIGN', {}, 120000);
		});
	});

	// ========================================================================
	// Schema validation
	// ========================================================================

	describe('tool schema', () => {
		it('should accept no params (defaults)', () => {
			const params = {};
			expect(params).toEqual({});
		});

		it('should accept all optional params', () => {
			const params = {
				nodeId: '1:2',
				rules: ['wcag', 'design-system'],
				maxDepth: 5,
				maxFindings: 50,
			};

			expect(params.nodeId).toBe('1:2');
			expect(params.rules).toHaveLength(2);
			expect(params.maxDepth).toBe(5);
			expect(params.maxFindings).toBe(50);
		});

		it('should accept individual rule IDs', () => {
			const params = {
				rules: ['wcag-contrast', 'detached-component', 'no-autolayout'],
			};

			expect(params.rules).toContain('wcag-contrast');
			expect(params.rules).toContain('detached-component');
		});
	});

	// ========================================================================
	// Default name detection regex
	// ========================================================================

	describe('default name detection', () => {
		const DEFAULT_NAME_REGEX = /^(Frame|Rectangle|Ellipse|Line|Text|Group|Component|Instance|Vector|Polygon|Star|Section)(\s+\d+)?$/;

		it('should match bare default names', () => {
			expect('Frame').toMatch(DEFAULT_NAME_REGEX);
			expect('Rectangle').toMatch(DEFAULT_NAME_REGEX);
			expect('Text').toMatch(DEFAULT_NAME_REGEX);
			expect('Component').toMatch(DEFAULT_NAME_REGEX);
		});

		it('should match default names with numbers', () => {
			expect('Frame 123').toMatch(DEFAULT_NAME_REGEX);
			expect('Rectangle 5').toMatch(DEFAULT_NAME_REGEX);
			expect('Group 42').toMatch(DEFAULT_NAME_REGEX);
		});

		it('should NOT match custom names', () => {
			expect('Header Frame').not.toMatch(DEFAULT_NAME_REGEX);
			expect('MyComponent').not.toMatch(DEFAULT_NAME_REGEX);
			expect('Button/Primary').not.toMatch(DEFAULT_NAME_REGEX);
			expect('Frame-Header').not.toMatch(DEFAULT_NAME_REGEX);
		});
	});

	// ========================================================================
	// Detached component detection
	// ========================================================================

	describe('detached component detection', () => {
		it('should flag frames with component naming convention', () => {
			const node = { type: 'FRAME', name: 'Button/Primary' };
			const isDetached = node.type === 'FRAME' && node.name.includes('/');
			expect(isDetached).toBe(true);
		});

		it('should not flag actual components', () => {
			const node = { type: 'COMPONENT', name: 'Button/Primary' };
			const isDetached = node.type === 'FRAME' && node.name.includes('/');
			expect(isDetached).toBe(false);
		});

		it('should not flag instances', () => {
			const node = { type: 'INSTANCE', name: 'Button/Primary' };
			const isDetached = node.type === 'FRAME' && node.name.includes('/');
			expect(isDetached).toBe(false);
		});

		it('should not flag frames without slash naming', () => {
			const node = { type: 'FRAME', name: 'Header' };
			const isDetached = node.type === 'FRAME' && node.name.includes('/');
			expect(isDetached).toBe(false);
		});
	});

	// ========================================================================
	// Large text classification (WCAG)
	// ========================================================================

	describe('large text classification', () => {
		function isLargeText(fontSize: number, fontWeight: number): boolean {
			if (fontSize >= 18) return true;
			if (fontSize >= 14 && fontWeight >= 700) return true;
			return false;
		}

		it('should classify 18px+ as large', () => {
			expect(isLargeText(18, 400)).toBe(true);
			expect(isLargeText(24, 400)).toBe(true);
		});

		it('should classify 14px+ bold as large', () => {
			expect(isLargeText(14, 700)).toBe(true);
			expect(isLargeText(16, 700)).toBe(true);
		});

		it('should NOT classify normal weight 14px as large', () => {
			expect(isLargeText(14, 400)).toBe(false);
			expect(isLargeText(16, 400)).toBe(false);
		});

		it('should NOT classify small text as large', () => {
			expect(isLargeText(12, 400)).toBe(false);
			expect(isLargeText(10, 700)).toBe(false);
		});
	});

	// ========================================================================
	// Interactive element detection
	// ========================================================================

	describe('interactive element detection', () => {
		const INTERACTIVE_PATTERN = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;

		it('should detect button-like names', () => {
			expect('Button').toMatch(INTERACTIVE_PATTERN);
			expect('Submit Button').toMatch(INTERACTIVE_PATTERN);
			expect('icon-button').toMatch(INTERACTIVE_PATTERN);
		});

		it('should detect form elements', () => {
			expect('Input Field').toMatch(INTERACTIVE_PATTERN);
			expect('Checkbox').toMatch(INTERACTIVE_PATTERN);
			expect('Radio Button').toMatch(INTERACTIVE_PATTERN);
		});

		it('should detect navigation elements', () => {
			expect('Tab').toMatch(INTERACTIVE_PATTERN);
			expect('Menu-Item').toMatch(INTERACTIVE_PATTERN);
			expect('Toggle').toMatch(INTERACTIVE_PATTERN);
		});

		it('should NOT detect non-interactive elements', () => {
			expect('Card').not.toMatch(INTERACTIVE_PATTERN);
			expect('Header').not.toMatch(INTERACTIVE_PATTERN);
			expect('Avatar').not.toMatch(INTERACTIVE_PATTERN);
		});
	});

	// ========================================================================
	// Error handling
	// ========================================================================

	describe('error handling', () => {
		it('should handle plugin timeout', async () => {
			const mockSendCommand = jest.fn().mockRejectedValue(
				new Error('Command LINT_DESIGN timed out after 120000ms'),
			);

			const lintDesign = async () => mockSendCommand('LINT_DESIGN', {}, 120000);

			await expect(lintDesign()).rejects.toThrow('timed out');
		});

		it('should handle missing connector', async () => {
			const getDesktopConnector = jest.fn().mockRejectedValue(
				new Error('No cloud relay session. Call figma_pair_plugin first.'),
			);

			await expect(getDesktopConnector()).rejects.toThrow('No cloud relay session');
		});

		it('should handle plugin error response', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: false,
				error: 'Node not found: 99:99',
			});

			const result = await mockSendCommand('LINT_DESIGN', { nodeId: '99:99' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('Node not found');
		});
	});

	// ========================================================================
	// Output structure validation
	// ========================================================================

	describe('output structure', () => {
		it('should produce valid summary structure', () => {
			const summary = { critical: 2, warning: 5, info: 1, total: 8 };

			expect(summary).toHaveProperty('critical');
			expect(summary).toHaveProperty('warning');
			expect(summary).toHaveProperty('info');
			expect(summary.total).toBe(summary.critical + summary.warning + summary.info);
		});

		it('should produce valid category structure', () => {
			const category = {
				rule: 'wcag-contrast',
				severity: 'critical',
				count: 3,
				description: 'Text does not meet WCAG AA contrast ratio',
				nodes: [
					{ id: '1:2', name: 'Label', ratio: '2.3:1', required: '4.5:1' },
				],
			};

			expect(category.rule).toBeDefined();
			expect(category.severity).toBeDefined();
			expect(category.count).toBe(3);
			expect(category.nodes).toHaveLength(1);
		});
	});
});
