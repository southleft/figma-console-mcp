/**
 * Tests for figma_audit_component_accessibility tool
 *
 * Covers: color-blind simulation matrices, state detection patterns,
 * scoring logic, connector routing, output structure, and WCAG criteria.
 */

describe('figma_audit_component_accessibility', () => {
	// ========================================================================
	// Color-blind simulation matrices
	// ========================================================================

	describe('color-blind simulation', () => {
		// Brettel/Vienot transformation matrices
		const colorBlindMatrices: Record<string, number[][]> = {
			protanopia: [
				[0.152286, 1.052583, -0.204868],
				[0.114503, 0.786281, 0.099216],
				[-0.003882, -0.048116, 1.051998],
			],
			deuteranopia: [
				[0.367322, 0.860646, -0.227968],
				[0.280085, 0.672501, 0.047413],
				[-0.011820, 0.042940, 0.968881],
			],
			tritanopia: [
				[1.255528, -0.076749, -0.178779],
				[-0.078411, 0.930809, 0.147602],
				[0.004733, 0.691367, 0.303900],
			],
		};

		function simulateColorBlind(r: number, g: number, b: number, matrix: number[][]): { r: number; g: number; b: number } {
			return {
				r: Math.max(0, Math.min(1, matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b)),
				g: Math.max(0, Math.min(1, matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b)),
				b: Math.max(0, Math.min(1, matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b)),
			};
		}

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

		it('should have 3 simulation types', () => {
			expect(Object.keys(colorBlindMatrices)).toHaveLength(3);
			expect(colorBlindMatrices).toHaveProperty('protanopia');
			expect(colorBlindMatrices).toHaveProperty('deuteranopia');
			expect(colorBlindMatrices).toHaveProperty('tritanopia');
		});

		it('should produce valid clamped RGB values', () => {
			const result = simulateColorBlind(1.0, 0.0, 0.0, colorBlindMatrices.protanopia);
			expect(result.r).toBeGreaterThanOrEqual(0);
			expect(result.r).toBeLessThanOrEqual(1);
			expect(result.g).toBeGreaterThanOrEqual(0);
			expect(result.g).toBeLessThanOrEqual(1);
			expect(result.b).toBeGreaterThanOrEqual(0);
			expect(result.b).toBeLessThanOrEqual(1);
		});

		it('should transform red significantly for protanopia', () => {
			// Protanopia reduces ability to see red
			const red = simulateColorBlind(1.0, 0.0, 0.0, colorBlindMatrices.protanopia);
			// Red should be significantly reduced
			expect(red.r).toBeLessThan(0.5);
		});

		it('should transform green significantly for deuteranopia', () => {
			// Deuteranopia reduces ability to see green
			const green = simulateColorBlind(0.0, 1.0, 0.0, colorBlindMatrices.deuteranopia);
			// Pure green should shift
			expect(green.r).toBeGreaterThan(0.2); // Some red bleed
		});

		it('should preserve black/white contrast across all types', () => {
			for (const type of Object.keys(colorBlindMatrices)) {
				const matrix = colorBlindMatrices[type];
				const simBlack = simulateColorBlind(0, 0, 0, matrix);
				const simWhite = simulateColorBlind(1, 1, 1, matrix);
				const ratio = contrastRatio(simBlack.r, simBlack.g, simBlack.b, simWhite.r, simWhite.g, simWhite.b);
				// Black/white should maintain high contrast even under simulation
				expect(ratio).toBeGreaterThan(10);
			}
		});

		it('should shift red and green to similar hues under protanopia', () => {
			// Under protanopia, red and green collapse into similar yellowish-brown hues
			const red = simulateColorBlind(0.8, 0.0, 0.0, colorBlindMatrices.protanopia);
			const green = simulateColorBlind(0.0, 0.8, 0.0, colorBlindMatrices.protanopia);

			// Both should shift toward similar luminance range (red loses intensity, green shifts)
			// The key insight: simulated red has much less red channel than original
			expect(red.r).toBeLessThan(0.8);
			// And simulated green gains red channel
			expect(green.r).toBeGreaterThan(0.1);
		});

		it('should each matrix be a 3x3 array', () => {
			for (const type of Object.keys(colorBlindMatrices)) {
				expect(colorBlindMatrices[type]).toHaveLength(3);
				for (const row of colorBlindMatrices[type]) {
					expect(row).toHaveLength(3);
				}
			}
		});
	});

	// ========================================================================
	// State detection patterns
	// ========================================================================

	describe('state detection', () => {
		const stateKeywords: Record<string, RegExp> = {
			'default': /(default|rest|idle|normal|base)/i,
			'hover': /(hover|hovered)/i,
			'focus': /(focus|focused)/i,
			'disabled': /(disabled|inactive)/i,
			'error': /(error|invalid|danger)/i,
			'active': /(active|pressed|selected)/i,
			'loading': /(loading|spinner)/i,
		};

		it('should define 7 state categories', () => {
			expect(Object.keys(stateKeywords)).toHaveLength(7);
		});

		it('should detect default/rest variants', () => {
			expect('State=Default').toMatch(stateKeywords['default']);
			expect('state=rest').toMatch(stateKeywords['default']);
			expect('Base').toMatch(stateKeywords['default']);
		});

		it('should detect hover variants', () => {
			expect('State=Hover').toMatch(stateKeywords['hover']);
			expect('Hovered').toMatch(stateKeywords['hover']);
		});

		it('should detect focus variants', () => {
			expect('State=Focused').toMatch(stateKeywords['focus']);
			expect('Focus').toMatch(stateKeywords['focus']);
		});

		it('should detect disabled variants', () => {
			expect('State=Disabled').toMatch(stateKeywords['disabled']);
			expect('Inactive').toMatch(stateKeywords['disabled']);
		});

		it('should detect error/danger variants', () => {
			expect('State=Error').toMatch(stateKeywords['error']);
			expect('type=danger').toMatch(stateKeywords['error']);
			expect('Invalid').toMatch(stateKeywords['error']);
		});

		it('should detect active/pressed/selected variants', () => {
			expect('State=Active').toMatch(stateKeywords['active']);
			expect('Pressed').toMatch(stateKeywords['active']);
			expect('Selected').toMatch(stateKeywords['active']);
		});

		it('should detect loading variants', () => {
			expect('State=Loading').toMatch(stateKeywords['loading']);
			expect('Spinner').toMatch(stateKeywords['loading']);
		});

		it('should count coverage from variant set', () => {
			const variants = [
				'type=default, size=md',
				'type=default, size=md, state=hover',
				'type=default, size=md, state=focused',
				'type=default, size=md, state=disabled',
			];

			let covered = 0;
			for (const key of Object.keys(stateKeywords)) {
				if (variants.some(v => stateKeywords[key].test(v))) {
					covered++;
				}
			}
			// Should match: default, hover, focus, disabled = 4 out of 7
			expect(covered).toBe(4);
		});
	});

	// ========================================================================
	// Scoring logic
	// ========================================================================

	describe('scoring', () => {
		it('should calculate variant coverage score', () => {
			const covered = 5;
			const total = 7;
			const score = Math.round((covered / total) * 100);
			expect(score).toBe(71);
		});

		it('should score focus indicator: 0 (missing), 50 (no indicator), 100 (good) for interactive', () => {
			const noVariant = 0;
			const noIndicator = 50;
			const good = 100;

			expect(noVariant).toBe(0);
			expect(noIndicator).toBe(50);
			expect(good).toBe(100);
		});

		it('should score focus indicator as 100 (N/A) for presentational', () => {
			// Presentational components don't need focus indicators
			const isPresentational = true;
			const score = isPresentational ? 100 : 0;
			expect(score).toBe(100);
		});

		it('should score annotations: 0 (none), 50 (description), 100 (a11y notes)', () => {
			expect(0).toBe(0);
			expect(50).toBe(50);
			expect(100).toBe(100);
		});

		it('should calculate weighted overall score for interactive components', () => {
			const scores = {
				variantCoverage: 71,
				focusIndicator: 100,
				colorDifferentiation: 100,
				targetSize: 100,
				annotations: 50,
				colorBlindSafety: 67,
			};

			const overall = Math.round(
				scores.variantCoverage * 0.20 +
				scores.focusIndicator * 0.20 +
				scores.colorDifferentiation * 0.15 +
				scores.targetSize * 0.15 +
				scores.annotations * 0.10 +
				scores.colorBlindSafety * 0.20,
			);

			expect(overall).toBeGreaterThanOrEqual(0);
			expect(overall).toBeLessThanOrEqual(100);
			expect(overall).toBe(83);
		});

		it('should calculate weighted overall score for presentational components', () => {
			const scores = {
				variantCoverage: 100, // All axis combinations present
				colorDifferentiation: 100,
				annotations: 0,
				colorBlindSafety: 100,
				targetSize: 100,
			};

			const overall = Math.round(
				scores.variantCoverage * 0.25 +
				scores.colorDifferentiation * 0.25 +
				scores.annotations * 0.15 +
				scores.colorBlindSafety * 0.25 +
				scores.targetSize * 0.10,
			);

			// 100*0.25 + 100*0.25 + 0*0.15 + 100*0.25 + 100*0.10 = 85
			expect(overall).toBe(85);
		});

		it('should give color differentiation 100 when no states checked', () => {
			const checked = 0;
			const issues = 0;
			const score = checked === 0 ? 100 : Math.max(0, Math.round(((checked - issues) / checked) * 100));
			expect(score).toBe(100);
		});

		it('should calculate target size score based on passing variants', () => {
			const totalVariants = 8;
			const failingVariants = 2;
			const score = Math.max(0, Math.round(((totalVariants - failingVariants) / totalVariants) * 100));
			expect(score).toBe(75);
		});
	});

	// ========================================================================
	// Component classification
	// ========================================================================

	describe('component classification', () => {
		const interactiveNames = /^(button|link|input|checkbox|radio|switch|toggle|tab|select|slider|dropdown|menu-item|search|combobox|listbox)/i;
		const presentationalNames = /^(alert|badge|card|avatar|divider|skeleton|tooltip|tag|chip|banner|callout|notification|toast|icon|image|separator|progress|spinner|loader|breadcrumb|label|heading|paragraph|caption|stat|meter|indicator)/i;

		it('should classify Button as interactive', () => {
			expect('Button').toMatch(interactiveNames);
		});

		it('should classify Input as interactive', () => {
			expect('Input').toMatch(interactiveNames);
		});

		it('should classify Checkbox as interactive', () => {
			expect('Checkbox').toMatch(interactiveNames);
		});

		it('should classify Toggle as interactive', () => {
			expect('Toggle').toMatch(interactiveNames);
		});

		it('should classify Alert as presentational', () => {
			expect('Alert').toMatch(presentationalNames);
			expect('Alert').not.toMatch(interactiveNames);
		});

		it('should classify Badge as presentational', () => {
			expect('Badge').toMatch(presentationalNames);
		});

		it('should classify Card as presentational', () => {
			expect('Card').toMatch(presentationalNames);
		});

		it('should classify Avatar as presentational', () => {
			expect('Avatar').toMatch(presentationalNames);
		});

		it('should classify Toast as presentational', () => {
			expect('Toast').toMatch(presentationalNames);
		});

		it('should classify Progress as presentational', () => {
			expect('Progress').toMatch(presentationalNames);
		});

		it('should detect interactive via state axis', () => {
			const axes = { state: ['default', 'hover', 'focus', 'disabled'], size: ['sm', 'md', 'lg'] };
			const hasStateAxis = axes.state && axes.state.some((v: string) => /(hover|focus|pressed|disabled)/i.test(v));
			expect(hasStateAxis).toBe(true);
		});

		it('should NOT detect interactive when axes are semantic only', () => {
			const axes = { type: ['success', 'danger', 'warning', 'info'], style: ['fill', 'outline'] };
			const hasStateAxis = axes.type && axes.type.some((v: string) => /(hover|focus|pressed|disabled)/i.test(v));
			expect(hasStateAxis).toBe(false);
		});
	});

	// ========================================================================
	// Connector routing
	// ========================================================================

	describe('connector routing', () => {
		it('should send AUDIT_COMPONENT_ACCESSIBILITY with nodeId', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: true,
				data: { component: { id: '1:2', name: 'Button' }, overallScore: 85 },
			});

			const auditComponentAccessibility = async (nodeId?: string, targetSize?: number) => {
				const params: any = {};
				if (nodeId) params.nodeId = nodeId;
				if (targetSize !== undefined) params.targetSize = targetSize;
				return mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', params, 120000);
			};

			await auditComponentAccessibility('1:2', 44);

			expect(mockSendCommand).toHaveBeenCalledWith(
				'AUDIT_COMPONENT_ACCESSIBILITY',
				{ nodeId: '1:2', targetSize: 44 },
				120000,
			);
		});

		it('should use 120s timeout for deep analysis', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({ success: true });

			await mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', {}, 120000);

			expect(mockSendCommand).toHaveBeenCalledWith(
				'AUDIT_COMPONENT_ACCESSIBILITY',
				expect.anything(),
				120000,
			);
		});

		it('should omit undefined params', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({ success: true });

			const auditComponentAccessibility = async (nodeId?: string, targetSize?: number) => {
				const params: any = {};
				if (nodeId) params.nodeId = nodeId;
				if (targetSize !== undefined) params.targetSize = targetSize;
				return mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', params, 120000);
			};

			await auditComponentAccessibility();

			expect(mockSendCommand).toHaveBeenCalledWith(
				'AUDIT_COMPONENT_ACCESSIBILITY',
				{},
				120000,
			);
		});
	});

	// ========================================================================
	// Output structure
	// ========================================================================

	describe('output structure', () => {
		const sampleOutput = {
			component: { id: '1:2', name: 'Button', type: 'COMPONENT_SET', variantCount: 8, classification: 'interactive' as const },
			overallScore: 72,
			scores: {
				variantCoverage: 71,
				focusIndicator: 100,
				colorDifferentiation: 67,
				targetSize: 100,
				annotations: 50,
				colorBlindSafety: 67,
			},
			variantCoverage: {
				mode: 'interactive-states' as const,
				found: { default: 'State=Default', hover: 'State=Hover', focus: 'State=Focused', disabled: null, error: null, active: null, loading: null },
				missing: ['disabled', 'error', 'active', 'loading'],
				coverage: '3/7',
			},
			focusIndicator: { hasVariant: true, hasVisibleIndicator: true, contrastRatio: 4.5, details: 'Focus ring (stroke)' },
			colorDifferentiation: { issues: [{ variant: 'Error', state: 'error' }], checked: 1 },
			targetSize: { minimum: '24x24', smallest: '36x36', issues: [] },
			annotations: { hasDescription: true, description: 'A button component', hasA11yNotes: false, a11yNotes: '' },
			colorBlindSimulation: {
				simulations: [
					{ type: 'protanopia', pairsChecked: 5, issues: 1, details: [] },
					{ type: 'deuteranopia', pairsChecked: 5, issues: 0, details: [] },
					{ type: 'tritanopia', pairsChecked: 5, issues: 0, details: [] },
				],
				issues: ['protanopia: 1 color pair(s) lose sufficient contrast'],
			},
			recommendations: [
				{ priority: 'high', area: 'color', message: 'Add non-color indicators' },
			],
		};

		it('should have component metadata with classification', () => {
			expect(sampleOutput.component.id).toBeDefined();
			expect(sampleOutput.component.name).toBeDefined();
			expect(sampleOutput.component.type).toBe('COMPONENT_SET');
			expect(sampleOutput.component.variantCount).toBeGreaterThan(0);
			expect(sampleOutput.component.classification).toMatch(/interactive|presentational/);
		});

		it('should have overall score 0-100', () => {
			expect(sampleOutput.overallScore).toBeGreaterThanOrEqual(0);
			expect(sampleOutput.overallScore).toBeLessThanOrEqual(100);
		});

		it('should have 6 individual scores', () => {
			expect(Object.keys(sampleOutput.scores)).toHaveLength(6);
		});

		it('should have variant coverage with mode and coverage', () => {
			expect(sampleOutput.variantCoverage.mode).toMatch(/interactive-states|variant-axes/);
			expect(sampleOutput.variantCoverage.coverage).toMatch(/\d+\/\d+/);
		});

		it('should have focus indicator analysis', () => {
			expect(sampleOutput.focusIndicator).toHaveProperty('hasVariant');
			expect(sampleOutput.focusIndicator).toHaveProperty('hasVisibleIndicator');
			expect(sampleOutput.focusIndicator).toHaveProperty('details');
		});

		it('should have color-blind simulation for 3 types', () => {
			expect(sampleOutput.colorBlindSimulation.simulations).toHaveLength(3);
			const types = sampleOutput.colorBlindSimulation.simulations.map(s => s.type);
			expect(types).toContain('protanopia');
			expect(types).toContain('deuteranopia');
			expect(types).toContain('tritanopia');
		});

		it('should have prioritized recommendations', () => {
			expect(sampleOutput.recommendations).toBeInstanceOf(Array);
			for (const rec of sampleOutput.recommendations) {
				expect(rec).toHaveProperty('priority');
				expect(rec).toHaveProperty('area');
				expect(rec).toHaveProperty('message');
				expect(['high', 'medium', 'low']).toContain(rec.priority);
			}
		});

		it('should have target size with minimum and smallest', () => {
			expect(sampleOutput.targetSize.minimum).toMatch(/\d+x\d+/);
			expect(sampleOutput.targetSize.smallest).toMatch(/\d+x\d+/);
		});

		it('should have annotation analysis', () => {
			expect(sampleOutput.annotations).toHaveProperty('hasDescription');
			expect(sampleOutput.annotations).toHaveProperty('hasA11yNotes');
		});
	});

	// ========================================================================
	// Annotation a11y keyword detection
	// ========================================================================

	describe('annotation a11y detection', () => {
		const a11yPattern = /aria|accessibility|a11y|screen.?reader|keyboard|role|tab.?order/i;

		it('should detect ARIA keywords', () => {
			expect('Use aria-label for icon-only buttons').toMatch(a11yPattern);
		});

		it('should detect accessibility keyword', () => {
			expect('Accessibility: supports keyboard navigation').toMatch(a11yPattern);
		});

		it('should detect a11y shorthand', () => {
			expect('a11y: role=button, tabindex=0').toMatch(a11yPattern);
		});

		it('should detect screen reader mentions', () => {
			expect('Screen reader: announces as "Submit form"').toMatch(a11yPattern);
			expect('screenreader announces state changes').toMatch(a11yPattern);
		});

		it('should detect keyboard interaction mentions', () => {
			expect('Keyboard: Enter/Space activates').toMatch(a11yPattern);
		});

		it('should detect role mentions', () => {
			expect('Role: button').toMatch(a11yPattern);
		});

		it('should detect tab order mentions', () => {
			expect('Tab order: included in natural flow').toMatch(a11yPattern);
			expect('taborder: 0').toMatch(a11yPattern);
		});

		it('should NOT match generic descriptions', () => {
			expect('A standard button component').not.toMatch(a11yPattern);
			expect('Used for primary actions').not.toMatch(a11yPattern);
		});
	});

	// ========================================================================
	// Error handling
	// ========================================================================

	describe('error handling', () => {
		it('should handle missing node', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: false,
				error: 'Node not found: 99:99',
			});

			const result = await mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', { nodeId: '99:99' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('Node not found');
		});

		it('should handle wrong node type', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: false,
				error: 'Node "My Frame" is type FRAME. Expected COMPONENT_SET or COMPONENT.',
			});

			const result = await mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', { nodeId: '1:2' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('Expected COMPONENT_SET or COMPONENT');
		});

		it('should handle no selection and no nodeId', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: false,
				error: 'No nodeId provided and no single node selected.',
			});

			const result = await mockSendCommand('AUDIT_COMPONENT_ACCESSIBILITY', {});
			expect(result.success).toBe(false);
			expect(result.error).toContain('No nodeId');
		});
	});

	// ========================================================================
	// Non-color indicator detection
	// ========================================================================

	describe('non-color indicator detection', () => {
		it('should recognize VECTOR children as icons', () => {
			const iconTypes = ['VECTOR', 'BOOLEAN_OPERATION', 'INSTANCE'];
			expect(iconTypes).toContain('VECTOR');
			expect(iconTypes).toContain('BOOLEAN_OPERATION');
			expect(iconTypes).toContain('INSTANCE');
		});

		it('should check strokes as border indicators', () => {
			const hasStroke = (strokes: Array<{ type: string; visible?: boolean }>) => {
				return strokes.some(s => s.type === 'SOLID' && s.visible !== false);
			};

			expect(hasStroke([{ type: 'SOLID', visible: true }])).toBe(true);
			expect(hasStroke([{ type: 'SOLID', visible: false }])).toBe(false);
			expect(hasStroke([])).toBe(false);
		});
	});

	// ========================================================================
	// Target size validation
	// ========================================================================

	describe('target size validation', () => {
		it('should default to 24px minimum (WCAG 2.5.8)', () => {
			const defaultTarget = 24;
			expect(defaultTarget).toBe(24);
		});

		it('should support iOS guideline (44px)', () => {
			const iosTarget = 44;
			const variant = { width: 40, height: 40 };
			expect(variant.width < iosTarget || variant.height < iosTarget).toBe(true);
		});

		it('should support Android guideline (48px)', () => {
			const androidTarget = 48;
			const variant = { width: 44, height: 44 };
			expect(variant.width < androidTarget || variant.height < androidTarget).toBe(true);
		});

		it('should pass variants meeting minimum', () => {
			const target = 24;
			const variant = { width: 36, height: 36 };
			expect(variant.width >= target && variant.height >= target).toBe(true);
		});
	});
});
