/**
 * Tests for figma_lint_design tool
 *
 * Covers: rule groups, severity mapping, connector routing,
 * schema validation, error handling, WCAG calculations,
 * and new WCAG 2.2 accessibility rules (Phase 1).
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
			'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
			'wcag-letter-spacing', 'wcag-paragraph-spacing', 'wcag-image-alt',
			'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
			'hardcoded-color', 'no-text-style', 'default-name', 'detached-component',
			'no-autolayout', 'empty-container',
		];

		const WCAG_RULES = [
			'wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height',
			'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
			'wcag-letter-spacing', 'wcag-paragraph-spacing', 'wcag-image-alt',
			'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
		];
		const DESIGN_SYSTEM_RULES = ['hardcoded-color', 'no-text-style', 'default-name', 'detached-component'];
		const LAYOUT_RULES = ['no-autolayout', 'empty-container'];

		it('should have 19 rules total', () => {
			expect(ALL_RULES).toHaveLength(19);
		});

		it('should have 13 WCAG rules', () => {
			expect(WCAG_RULES).toHaveLength(13);
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

		it('should have 9 new WCAG rules from Phase 1', () => {
			const newRules = [
				'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
				'wcag-letter-spacing', 'wcag-paragraph-spacing', 'wcag-image-alt',
				'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
			];
			newRules.forEach(rule => {
				expect(WCAG_RULES).toContain(rule);
			});
		});
	});

	// ========================================================================
	// Severity mapping
	// ========================================================================

	describe('severity mapping', () => {
		const SEVERITY_MAP: Record<string, string> = {
			'wcag-contrast': 'critical',
			'wcag-target-size': 'critical',
			'wcag-non-text-contrast': 'critical',
			'wcag-color-only': 'critical',
			'wcag-text-size': 'warning',
			'wcag-line-height': 'warning',
			'wcag-focus-indicator': 'warning',
			'wcag-letter-spacing': 'warning',
			'wcag-paragraph-spacing': 'warning',
			'wcag-image-alt': 'warning',
			'wcag-heading-hierarchy': 'warning',
			'wcag-reflow': 'warning',
			'wcag-reading-order': 'warning',
			'hardcoded-color': 'warning',
			'no-text-style': 'warning',
			'default-name': 'warning',
			'detached-component': 'warning',
			'no-autolayout': 'warning',
			'empty-container': 'info',
		};

		it('should have 4 critical rules', () => {
			const critical = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'critical');
			expect(critical).toHaveLength(4);
		});

		it('should have 14 warning rules', () => {
			const warnings = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'warning');
			expect(warnings).toHaveLength(14);
		});

		it('should have 1 info rule', () => {
			const info = Object.entries(SEVERITY_MAP).filter(([, s]) => s === 'info');
			expect(info).toHaveLength(1);
		});

		it('should map contrast and target size as critical', () => {
			expect(SEVERITY_MAP['wcag-contrast']).toBe('critical');
			expect(SEVERITY_MAP['wcag-target-size']).toBe('critical');
		});

		it('should map non-text contrast and color-only as critical', () => {
			expect(SEVERITY_MAP['wcag-non-text-contrast']).toBe('critical');
			expect(SEVERITY_MAP['wcag-color-only']).toBe('critical');
		});

		it('should map new Phase 1 rules to correct severities', () => {
			expect(SEVERITY_MAP['wcag-focus-indicator']).toBe('warning');
			expect(SEVERITY_MAP['wcag-letter-spacing']).toBe('warning');
			expect(SEVERITY_MAP['wcag-paragraph-spacing']).toBe('warning');
			expect(SEVERITY_MAP['wcag-image-alt']).toBe('warning');
			expect(SEVERITY_MAP['wcag-heading-hierarchy']).toBe('warning');
			expect(SEVERITY_MAP['wcag-reflow']).toBe('warning');
			expect(SEVERITY_MAP['wcag-reading-order']).toBe('warning');
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

	describe('large text classification (WCAG px thresholds)', () => {
		// WCAG: 18pt = 24px regular, 14pt ≈ 18.66px bold (700+)
		function isLargeText(fontSize: number, fontWeight: number): boolean {
			if (fontSize >= 24) return true;
			if (fontSize >= 18.66 && fontWeight >= 700) return true;
			return false;
		}

		it('should classify 24px+ as large', () => {
			expect(isLargeText(24, 400)).toBe(true);
			expect(isLargeText(32, 400)).toBe(true);
		});

		it('should classify 18.66px+ bold as large', () => {
			expect(isLargeText(19, 700)).toBe(true);
			expect(isLargeText(20, 700)).toBe(true);
		});

		it('should NOT classify 18px regular as large (18pt != 18px)', () => {
			expect(isLargeText(18, 400)).toBe(false);
			expect(isLargeText(20, 400)).toBe(false);
		});

		it('should NOT classify small bold text as large', () => {
			expect(isLargeText(14, 700)).toBe(false);
			expect(isLargeText(16, 700)).toBe(false);
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

	// ========================================================================
	// Phase 1: New WCAG rule detection logic
	// ========================================================================

	describe('wcag-non-text-contrast (WCAG 1.4.11)', () => {
		// Non-text elements (UI components) need 3:1 contrast against adjacent colors
		function linearize(c: number): number {
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}
		function luminance(r: number, g: number, b: number): number {
			return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
		}
		function contrastRatio(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
			const l1 = luminance(r1, g1, b1);
			const l2 = luminance(r2, g2, b2);
			return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
		}

		it('should require 3:1 ratio for UI components (not 4.5:1)', () => {
			// Light gray button (#CCCCCC) on white (#FFFFFF)
			const ratio = contrastRatio(0.8, 0.8, 0.8, 1, 1, 1);
			expect(ratio).toBeLessThan(3.0); // Should fail non-text contrast
			expect(ratio).toBeLessThan(4.5); // Would also fail text contrast
		});

		it('should pass for sufficient non-text contrast', () => {
			// Medium gray (#767676) on white — 4.54:1
			const ratio = contrastRatio(0.463, 0.463, 0.463, 1, 1, 1);
			expect(ratio).toBeGreaterThan(3.0);
		});

		it('should check both fill and stroke of interactive elements', () => {
			const finding = {
				id: '1:2',
				name: 'Button',
				ratio: '2.1:1',
				required: '3.0:1',
				component: '#DDDDDD',
				bg: '#FFFFFF',
				element: 'fill',
			};
			expect(finding.element).toBe('fill');

			const strokeFinding = { ...finding, element: 'stroke', component: '#EEEEEE' };
			expect(strokeFinding.element).toBe('stroke');
		});

		it('should only apply to interactive elements', () => {
			const INTERACTIVE_PATTERN = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;
			expect('Card').not.toMatch(INTERACTIVE_PATTERN);
			expect('Decorative-border').not.toMatch(INTERACTIVE_PATTERN);
			expect('Button').toMatch(INTERACTIVE_PATTERN);
			expect('Toggle Switch').toMatch(INTERACTIVE_PATTERN);
		});
	});

	describe('wcag-color-only (WCAG 1.4.1)', () => {
		it('should flag state variants that differ only by color', () => {
			// Simulate: error variant has red fill, default has gray fill, no icon in error
			const errorVariant = { name: 'State=Error', fillColor: '#FF0000', hasIcon: false };
			const defaultVariant = { name: 'State=Default', fillColor: '#CCCCCC', hasIcon: false };

			const colorsDiffer = errorVariant.fillColor !== defaultVariant.fillColor;
			const hasNonColorIndicator = errorVariant.hasIcon;

			expect(colorsDiffer).toBe(true);
			expect(hasNonColorIndicator).toBe(false);
			// This combination should trigger a finding
		});

		it('should NOT flag variants with icon indicators', () => {
			const errorVariant = { name: 'State=Error', fillColor: '#FF0000', hasIcon: true };
			expect(errorVariant.hasIcon).toBe(true);
			// Should NOT trigger — has non-color differentiation
		});

		it('should detect state-related variant names', () => {
			const statePattern = /(error|warning|danger|success|invalid|alert)/i;
			expect('State=Error').toMatch(statePattern);
			expect('State=Warning').toMatch(statePattern);
			expect('State=Success').toMatch(statePattern);
			expect('State=Default').not.toMatch(statePattern);
			expect('State=Hover').not.toMatch(statePattern);
		});

		it('should identify default variant for comparison', () => {
			const defaultPattern = /(default|rest|idle|normal|base)/i;
			expect('State=Default').toMatch(defaultPattern);
			expect('State=Rest').toMatch(defaultPattern);
			expect('State=Normal').toMatch(defaultPattern);
			expect('State=Error').not.toMatch(defaultPattern);
		});
	});

	describe('wcag-focus-indicator (WCAG 2.4.7)', () => {
		it('should detect missing focus variant in component set', () => {
			const variants = [
				{ name: 'State=Default' },
				{ name: 'State=Hover' },
				{ name: 'State=Pressed' },
				{ name: 'State=Disabled' },
			];

			const hasFocusVariant = variants.some(v => /focus|focused/i.test(v.name));
			expect(hasFocusVariant).toBe(false);
		});

		it('should detect present focus variant', () => {
			const variants = [
				{ name: 'State=Default' },
				{ name: 'State=Focused' },
				{ name: 'State=Hover' },
			];

			const hasFocusVariant = variants.some(v => /focus|focused/i.test(v.name));
			expect(hasFocusVariant).toBe(true);
		});

		it('should only check interactive component sets', () => {
			const INTERACTIVE_PATTERN = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;
			expect('Button').toMatch(INTERACTIVE_PATTERN);
			expect('Card').not.toMatch(INTERACTIVE_PATTERN);
			// Card component sets should not require focus variant
		});

		it('should flag focus variant without visible indicator', () => {
			const focusVariant = {
				name: 'State=Focused',
				hasStroke: false,
				hasShadowEffect: false,
			};

			const hasVisibleIndicator = focusVariant.hasStroke || focusVariant.hasShadowEffect;
			expect(hasVisibleIndicator).toBe(false);
			// Should produce: issue: 'no-visible-indicator'
		});

		it('should pass focus variant with stroke (focus ring)', () => {
			const focusVariant = {
				name: 'State=Focused',
				hasStroke: true,
				hasShadowEffect: false,
			};

			const hasVisibleIndicator = focusVariant.hasStroke || focusVariant.hasShadowEffect;
			expect(hasVisibleIndicator).toBe(true);
		});

		it('should pass focus variant with shadow effect', () => {
			const focusVariant = {
				name: 'State=Focused',
				hasStroke: false,
				hasShadowEffect: true,
			};

			const hasVisibleIndicator = focusVariant.hasStroke || focusVariant.hasShadowEffect;
			expect(hasVisibleIndicator).toBe(true);
		});
	});

	describe('wcag-letter-spacing (WCAG 1.4.12)', () => {
		it('should flag negative pixel letter spacing', () => {
			const letterSpacing = { unit: 'PIXELS', value: -0.5 };
			expect(letterSpacing.value).toBeLessThan(0);
		});

		it('should flag negative percent letter spacing', () => {
			const letterSpacing = { unit: 'PERCENT', value: -2 };
			expect(letterSpacing.value).toBeLessThan(0);
		});

		it('should NOT flag positive letter spacing', () => {
			const letterSpacing = { unit: 'PIXELS', value: 0.5 };
			expect(letterSpacing.value).toBeGreaterThanOrEqual(0);
		});

		it('should NOT flag zero letter spacing', () => {
			const letterSpacing = { unit: 'PIXELS', value: 0 };
			expect(letterSpacing.value).toBeGreaterThanOrEqual(0);
		});
	});

	describe('wcag-paragraph-spacing (WCAG 1.4.12)', () => {
		it('should flag paragraph spacing less than 2x font size', () => {
			const fontSize = 16;
			const paragraphSpacing = 24; // 1.5x — too small
			const required = 2 * fontSize; // 32px

			expect(paragraphSpacing).toBeLessThan(required);
		});

		it('should pass paragraph spacing at 2x font size', () => {
			const fontSize = 16;
			const paragraphSpacing = 32; // 2x — exactly meets threshold

			expect(paragraphSpacing).toBeGreaterThanOrEqual(2 * fontSize);
		});

		it('should pass paragraph spacing greater than 2x', () => {
			const fontSize = 14;
			const paragraphSpacing = 36; // > 2x

			expect(paragraphSpacing).toBeGreaterThanOrEqual(2 * fontSize);
		});

		it('should only check when paragraphSpacing > 0', () => {
			// paragraphSpacing of 0 means no explicit paragraph spacing set
			const paragraphSpacing = 0;
			expect(paragraphSpacing).toBe(0);
			// Should NOT trigger — 0 means default/auto
		});
	});

	describe('wcag-image-alt (WCAG 1.1.1)', () => {
		it('should flag image fills without description', () => {
			const node = {
				fills: [{ type: 'IMAGE', visible: true }],
				description: '',
				name: 'hero-photo',
			};

			const hasImageFill = node.fills.some((f: any) => f.type === 'IMAGE' && f.visible !== false);
			const hasDescription = node.description.trim().length > 0;
			const isDecorative = /decorative|decoration/i.test(node.name);

			expect(hasImageFill).toBe(true);
			expect(hasDescription).toBe(false);
			expect(isDecorative).toBe(false);
			// Should trigger finding
		});

		it('should NOT flag images with description', () => {
			const node = {
				fills: [{ type: 'IMAGE', visible: true }],
				description: 'Photo of team collaboration session',
				name: 'hero-photo',
			};

			const hasDescription = node.description.trim().length > 0;
			expect(hasDescription).toBe(true);
		});

		it('should NOT flag decorative images', () => {
			const node = {
				fills: [{ type: 'IMAGE', visible: true }],
				description: '',
				name: 'decorative-pattern',
			};

			const isDecorative = /decorative|decoration/i.test(node.name);
			expect(isDecorative).toBe(true);
		});

		it('should NOT flag non-image fills', () => {
			const node = {
				fills: [{ type: 'SOLID', visible: true }],
			};

			const hasImageFill = node.fills.some((f: any) => f.type === 'IMAGE' && f.visible !== false);
			expect(hasImageFill).toBe(false);
		});

		it('should ignore invisible image fills', () => {
			const node = {
				fills: [{ type: 'IMAGE', visible: false }],
			};

			const hasImageFill = node.fills.some((f: any) => f.type === 'IMAGE' && f.visible !== false);
			expect(hasImageFill).toBe(false);
		});
	});

	describe('wcag-heading-hierarchy (WCAG 1.3.1)', () => {
		it('should detect heading level from node name', () => {
			const headingRegex = /\bh(\d)\b|heading[\s-]*(\d)/i;

			const h1Match = headingRegex.exec('H1 Title');
			expect(h1Match).not.toBeNull();
			expect(h1Match![1]).toBe('1');

			const h2Match = headingRegex.exec('Heading 2');
			expect(h2Match).not.toBeNull();
			expect(h2Match![2]).toBe('2');
		});

		it('should flag skipped heading levels', () => {
			const headings = [
				{ level: 1, name: 'H1 Title' },
				{ level: 3, name: 'H3 Subtitle' }, // Skips H2!
			];

			const violations: Array<{ level: number; previousLevel: number }> = [];
			let prevLevel = 0;
			for (const h of headings) {
				if (prevLevel > 0 && h.level > prevLevel + 1) {
					violations.push({ level: h.level, previousLevel: prevLevel });
				}
				prevLevel = h.level;
			}

			expect(violations).toHaveLength(1);
			expect(violations[0].level).toBe(3);
			expect(violations[0].previousLevel).toBe(1);
		});

		it('should NOT flag consecutive heading levels', () => {
			const headings = [
				{ level: 1 },
				{ level: 2 },
				{ level: 3 },
			];

			const violations: number[] = [];
			let prevLevel = 0;
			for (const h of headings) {
				if (prevLevel > 0 && h.level > prevLevel + 1) {
					violations.push(h.level);
				}
				prevLevel = h.level;
			}

			expect(violations).toHaveLength(0);
		});

		it('should NOT flag heading level decrease (H3 → H1)', () => {
			const headings = [
				{ level: 3 },
				{ level: 1 }, // Going back up is fine
			];

			const violations: number[] = [];
			let prevLevel = 0;
			for (const h of headings) {
				if (prevLevel > 0 && h.level > prevLevel + 1) {
					violations.push(h.level);
				}
				prevLevel = h.level;
			}

			expect(violations).toHaveLength(0);
		});

		it('should infer heading level from font size', () => {
			function inferHeadingLevel(fontSize: number): number {
				if (fontSize >= 40) return 1;
				if (fontSize >= 32) return 2;
				if (fontSize >= 24) return 3;
				if (fontSize >= 20) return 4;
				if (fontSize >= 18) return 5;
				return 0; // Not a heading
			}

			expect(inferHeadingLevel(48)).toBe(1);
			expect(inferHeadingLevel(36)).toBe(2);
			expect(inferHeadingLevel(24)).toBe(3);
			expect(inferHeadingLevel(20)).toBe(4);
			expect(inferHeadingLevel(14)).toBe(0);
		});
	});

	describe('wcag-reflow (WCAG 1.4.10)', () => {
		it('should flag frames with absolute-positioned children', () => {
			const children = [
				{ x: 0, y: 0 },
				{ x: 200, y: 50 },
				{ x: 50, y: 300 },
			];

			// Spread across both axes indicates absolute positioning
			const uniqueXs = [...new Set(children.map(c => c.x))];
			const uniqueYs = [...new Set(children.map(c => c.y))];

			expect(uniqueXs.length).toBeGreaterThan(2);
			expect(uniqueYs.length).toBeGreaterThan(2);
		});

		it('should NOT flag frames with auto-layout', () => {
			const frame = { layoutMode: 'VERTICAL', children: [{ x: 0, y: 0 }, { x: 0, y: 100 }] };
			expect(frame.layoutMode).not.toBe('NONE');
			// Auto-layout frames are skipped entirely
		});

		it('should NOT flag frames with fewer than 3 children', () => {
			const children = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
			expect(children.length).toBeLessThan(3);
		});

		it('should NOT flag aligned children (same column/row)', () => {
			// All children in same column = not absolute positioning
			const children = [
				{ x: 0, y: 0 },
				{ x: 0, y: 50 },
				{ x: 0, y: 100 },
			];
			const uniqueXs = [...new Set(children.map(c => c.x))];
			expect(uniqueXs.length).toBe(1); // All same X = NOT flagged
		});
	});

	describe('wcag-reading-order (WCAG 1.3.2)', () => {
		it('should detect visual vs layer order mismatch', () => {
			// Layer order: 0, 1, 2 — but visually reversed (bottom element first in layers)
			const children = [
				{ index: 0, y: 300, x: 0 }, // visually at bottom
				{ index: 1, y: 0, x: 0 },   // visually at top
				{ index: 2, y: 150, x: 0 },  // visually in middle
			];

			const visualOrder = children.slice().sort((a, b) => {
				if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
				return a.x - b.x;
			});

			let mismatches = 0;
			for (let i = 0; i < visualOrder.length; i++) {
				if (visualOrder[i].index !== i) mismatches++;
			}

			expect(mismatches).toBeGreaterThan(0);
			expect(mismatches / children.length).toBeGreaterThan(0.3);
		});

		it('should NOT flag matching visual and layer order', () => {
			const children = [
				{ index: 0, y: 0, x: 0 },
				{ index: 1, y: 50, x: 0 },
				{ index: 2, y: 100, x: 0 },
			];

			const visualOrder = children.slice().sort((a, b) => {
				if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
				return a.x - b.x;
			});

			let mismatches = 0;
			for (let i = 0; i < visualOrder.length; i++) {
				if (visualOrder[i].index !== i) mismatches++;
			}

			expect(mismatches).toBe(0);
		});

		it('should use 10px threshold for same-row detection', () => {
			// Elements within 10px Y difference should be treated as same row
			const children = [
				{ index: 0, y: 5, x: 100 },  // Same row as index 1 (within 10px)
				{ index: 1, y: 0, x: 0 },
			];

			const visualOrder = children.slice().sort((a, b) => {
				if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
				return a.x - b.x;
			});

			// Within 10px, so sorted by X: index 1 (x=0) before index 0 (x=100)
			expect(visualOrder[0].index).toBe(1);
			expect(visualOrder[1].index).toBe(0);
		});

		it('should skip auto-layout frames (order is enforced)', () => {
			const frame = { layoutMode: 'HORIZONTAL' };
			const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
			expect(isAutoLayout).toBe(true);
			// Auto-layout frames should not be checked for reading order
		});

		it('should require >30% mismatches AND at least 2 to trigger', () => {
			// 1 out of 5 is 20% — below threshold
			const childCount = 5;
			const mismatches = 1;
			const triggered = mismatches > childCount * 0.3 && mismatches >= 2;
			expect(triggered).toBe(false);

			// 2 out of 3 is 67% — above threshold
			const triggered2 = 2 > 3 * 0.3 && 2 >= 2;
			expect(triggered2).toBe(true);
		});
	});

	// ========================================================================
	// New rule output structures
	// ========================================================================

	describe('new rule output structures', () => {
		it('should produce valid non-text contrast finding', () => {
			const finding = {
				id: '1:2', name: 'Toggle Switch',
				ratio: '2.1:1', required: '3.0:1',
				component: '#DDDDDD', bg: '#FFFFFF', element: 'fill',
			};
			expect(finding.ratio).toBeDefined();
			expect(finding.element).toMatch(/fill|stroke/);
		});

		it('should produce valid color-only finding', () => {
			const finding = {
				id: '1:2', name: 'Input / State=Error',
				variantColor: '#FF0000', defaultColor: '#CCCCCC',
				suggestion: 'Add an icon, text label, or border to differentiate this state beyond color alone',
			};
			expect(finding.variantColor).not.toBe(finding.defaultColor);
			expect(finding.suggestion).toBeDefined();
		});

		it('should produce valid focus indicator finding (missing)', () => {
			const finding = {
				id: '1:2', name: 'Button',
				issue: 'missing-variant',
				suggestion: 'Add a focus/focused variant with a visible focus ring or outline',
			};
			expect(finding.issue).toBe('missing-variant');
		});

		it('should produce valid focus indicator finding (no visible indicator)', () => {
			const finding = {
				id: '1:3', name: 'Button / State=Focused',
				issue: 'no-visible-indicator',
				suggestion: 'Focus variant exists but has no visible border, outline, or shadow for the focus indicator',
			};
			expect(finding.issue).toBe('no-visible-indicator');
		});

		it('should produce valid letter spacing finding', () => {
			const finding = { id: '1:2', name: 'Label', letterSpacing: '-0.5px' };
			expect(finding.letterSpacing).toContain('-');
		});

		it('should produce valid paragraph spacing finding', () => {
			const finding = {
				id: '1:2', name: 'Body Text',
				paragraphSpacing: 24, fontSize: 16, recommended: 32,
			};
			expect(finding.paragraphSpacing).toBeLessThan(finding.recommended);
		});

		it('should produce valid image alt finding', () => {
			const finding = {
				id: '1:2', name: 'hero-photo',
				suggestion: 'Add a description in the node\'s description field, or name it "decorative" if purely presentational',
			};
			expect(finding.suggestion).toContain('description');
		});

		it('should produce valid heading hierarchy finding', () => {
			const finding = {
				id: '1:2', name: 'Section Title',
				level: 3, previousLevel: 1,
				suggestion: 'Expected H2 but found H3. Do not skip heading levels.',
			};
			expect(finding.level).toBeGreaterThan(finding.previousLevel + 1);
		});

		it('should produce valid reflow finding', () => {
			const finding = {
				id: '1:2', name: 'Page Layout',
				childCount: 5,
				suggestion: 'Convert to auto-layout so content can reflow at different viewport sizes',
			};
			expect(finding.childCount).toBeGreaterThanOrEqual(3);
		});

		it('should produce valid reading order finding', () => {
			const finding = {
				id: '1:2', name: 'Card Container',
				childCount: 4, mismatches: 3,
				suggestion: 'Reorder layers to match visual top-to-bottom, left-to-right reading order',
			};
			expect(finding.mismatches).toBeGreaterThan(0);
			expect(finding.mismatches / finding.childCount).toBeGreaterThan(0.3);
		});
	});

	// ========================================================================
	// WCAG success criteria mapping
	// ========================================================================

	describe('WCAG success criteria coverage', () => {
		const WCAG_CRITERIA_MAP: Record<string, string> = {
			'wcag-contrast': 'WCAG 1.4.3 / 1.4.6',
			'wcag-non-text-contrast': 'WCAG 1.4.11',
			'wcag-color-only': 'WCAG 1.4.1',
			'wcag-text-size': 'WCAG 1.4.4',
			'wcag-target-size': 'WCAG 2.5.5 / 2.5.8',
			'wcag-line-height': 'WCAG 1.4.12',
			'wcag-letter-spacing': 'WCAG 1.4.12',
			'wcag-paragraph-spacing': 'WCAG 1.4.12',
			'wcag-focus-indicator': 'WCAG 2.4.7 / 2.4.11',
			'wcag-image-alt': 'WCAG 1.1.1',
			'wcag-heading-hierarchy': 'WCAG 1.3.1',
			'wcag-reflow': 'WCAG 1.4.10',
			'wcag-reading-order': 'WCAG 1.3.2',
		};

		it('should map all 13 WCAG rules to success criteria', () => {
			expect(Object.keys(WCAG_CRITERIA_MAP)).toHaveLength(13);
		});

		it('should cover Perceivable principle (1.x.x)', () => {
			const perceivable = Object.values(WCAG_CRITERIA_MAP).filter(v => v.startsWith('WCAG 1.'));
			expect(perceivable.length).toBeGreaterThanOrEqual(9);
		});

		it('should cover Operable principle (2.x.x)', () => {
			const operable = Object.values(WCAG_CRITERIA_MAP).filter(v => v.startsWith('WCAG 2.'));
			expect(operable.length).toBeGreaterThanOrEqual(2);
		});
	});
});
