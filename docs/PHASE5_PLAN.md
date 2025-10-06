# Phase 5: Enriched Data Extraction & Design System Auditing

## Overview

Phase 5 enhances the Figma data extraction tools (8-11) to return **resolved, enriched data** that provides better context for AI decision-making and enables **design system auditing** capabilities.

## Goals

1. **Enrich API responses** with resolved values, relationships, and multiple export formats
2. **Enable design system auditing** - detect inconsistencies, unused tokens, missing variables
3. **Provide better AI context** - reduce need for multiple API calls to get complete picture
4. **Maintain backward compatibility** - add new fields without breaking existing responses
5. **Support multiple export formats** - CSS vars, Sass, Tailwind, TypeScript, JSON

## Use Cases

### 1. Design System Auditing
```javascript
// Detect unused design tokens
figma_audit_design_tokens()
// → Returns: { unused: [...], inconsistent: [...], missing: [...] }

// Find components not using design tokens
figma_audit_components()
// → Returns: { hardcoded_values: [...], missing_token_refs: [...] }
```

### 2. Enriched Data Extraction
```javascript
// Current response (Phase 4):
{
  "name": "color/background/primary-default",
  "style_type": "FILL",
  "node_id": "371:850"
}

// Enhanced response (Phase 5):
{
  "name": "color/background/primary-default",
  "style_type": "FILL",
  "node_id": "371:850",
  "resolved_value": "#4375FF",
  "variable_reference": {
    "id": "VariableID:abc123",
    "name": "color/background/primary-default",
    "collection": "Altitude Design System"
  },
  "used_in_components": [
    { "id": "1791:11519", "name": "Button", "variant": "primary" },
    { "id": "2345:678", "name": "Card", "variant": "default" }
  ],
  "usage_count": 42,
  "export_formats": {
    "css": "var(--color-background-primary-default)",
    "sass": "$color-background-primary-default",
    "tailwind": "bg-primary",
    "typescript": "tokens.color.background.primary.default",
    "json": { "color": { "background": { "primary": { "default": "#4375FF" } } } }
  }
}
```

### 3. Token Architecture Validation
```javascript
// Check token naming consistency
figma_validate_token_naming()
// → Returns: { consistent: true, violations: [...] }

// Find circular variable references
figma_check_variable_dependencies()
// → Returns: { circular_refs: [...], orphaned_vars: [...] }
```

## Architecture

### New Core Modules

```
src/core/
  ├── enrichment/
  │   ├── style-resolver.ts      # Resolve style values from variables
  │   ├── component-analyzer.ts   # Analyze component usage of styles/vars
  │   ├── relationship-mapper.ts  # Map relationships between entities
  │   └── format-exporter.ts      # Export to multiple formats
  ├── auditing/
  │   ├── token-auditor.ts        # Audit design tokens
  │   ├── component-auditor.ts    # Audit component usage
  │   ├── naming-validator.ts     # Validate naming conventions
  │   └── dependency-checker.ts   # Check variable dependencies
```

### Enhanced API Response Types

```typescript
// Enhanced style response
interface EnrichedStyle {
  // Existing fields
  node_id: string;
  name: string;
  style_type: string;

  // New enriched fields
  resolved_value: string | object;
  variable_reference?: {
    id: string;
    name: string;
    collection: string;
  };
  used_in_components: ComponentUsage[];
  usage_count: number;
  export_formats: ExportFormats;
  last_modified?: string;
  created_by?: string;
}

// Enhanced variable response
interface EnrichedVariable {
  // Existing fields
  id: string;
  name: string;
  resolvedType: string;

  // New enriched fields
  resolved_values: Record<string, any>; // Per mode
  used_in_styles: StyleUsage[];
  used_in_components: ComponentUsage[];
  usage_count: number;
  dependencies: VariableDependency[];
  export_formats: ExportFormats;
}

// Enhanced component response
interface EnrichedComponent {
  // Existing fields
  id: string;
  name: string;
  type: string;

  // New enriched fields
  styles_used: StyleReference[];
  variables_used: VariableReference[];
  hardcoded_values: HardcodedValue[];
  token_coverage: number; // % of values using tokens
  audit_issues: AuditIssue[];
}
```

## Implementation Tasks

### Phase 5.1: Foundation (Week 1)

- [ ] **Task 1.1**: Create enrichment module structure
  - Create `src/core/enrichment/` directory
  - Set up TypeScript types for enriched responses
  - Add new response schemas with Zod validation

- [ ] **Task 1.2**: Implement style value resolver
  - Resolve variable references to actual values
  - Handle mode-specific variable values
  - Support nested variable references (alias chains)
  - Cache resolved values for performance

- [ ] **Task 1.3**: Implement relationship mapper
  - Map which components use which styles
  - Map which styles use which variables
  - Build usage count tracking
  - Create reverse lookup indexes

### Phase 5.2: Enriched Data (Week 2)

- [ ] **Task 2.1**: Enhance `figma_get_styles()`
  - Add resolved values to response
  - Add variable references
  - Add component usage data
  - Add usage counts
  - Maintain backward compatibility with optional `enrich: true` parameter

- [ ] **Task 2.2**: Enhance `figma_get_variables()`
  - Add resolved values per mode
  - Add style and component usage
  - Add dependency tree
  - Add usage statistics

- [ ] **Task 2.3**: Enhance `figma_get_component()`
  - Add styles used with resolved values
  - Add variables used with resolved values
  - Detect hardcoded values vs token usage
  - Calculate token coverage percentage

- [ ] **Task 2.4**: Enhance `figma_get_file_data()`
  - Add summary statistics (total tokens, usage, etc.)
  - Add file-level audit summary
  - Add token architecture health score

### Phase 5.3: Export Formats (Week 3)

- [ ] **Task 3.1**: Implement CSS Variables exporter
  - Convert variables to CSS custom properties format
  - Handle color, number, string, boolean types
  - Generate complete CSS file output

- [ ] **Task 3.2**: Implement Sass/SCSS exporter
  - Convert to Sass variable format
  - Support nested structure
  - Generate .scss file output

- [ ] **Task 3.3**: Implement Tailwind config exporter
  - Map to Tailwind config structure
  - Support theme extension format
  - Generate tailwind.config.js output

- [ ] **Task 3.4**: Implement TypeScript exporter
  - Generate typed token objects
  - Create TypeScript interfaces
  - Support autocomplete-friendly structure

- [ ] **Task 3.5**: Implement JSON/JavaScript exporter
  - Clean JSON structure
  - JavaScript module format
  - ES6 and CommonJS support

### Phase 5.4: Auditing Tools (Week 4)

- [ ] **Task 4.1**: Implement token auditor
  - Detect unused tokens
  - Find inconsistent naming
  - Check for duplicate values
  - Validate token structure

- [ ] **Task 4.2**: Implement component auditor
  - Find hardcoded values in components
  - Detect missing token references
  - Calculate token coverage per component
  - Suggest token replacements

- [ ] **Task 4.3**: Implement naming validator
  - Check naming convention compliance
  - Detect naming pattern violations
  - Suggest naming improvements
  - Support custom naming rules

- [ ] **Task 4.4**: Implement dependency checker
  - Build variable dependency graph
  - Detect circular references
  - Find orphaned variables
  - Check for broken references

### Phase 5.5: New MCP Tools (Week 5)

- [ ] **Task 5.1**: Add `figma_export_tokens()` tool
  ```javascript
  figma_export_tokens({
    format: 'css' | 'sass' | 'tailwind' | 'typescript' | 'json',
    includeUsage: boolean,
    includeComments: boolean
  })
  ```

- [ ] **Task 5.2**: Add `figma_audit_design_system()` tool
  ```javascript
  figma_audit_design_system({
    checkNaming: boolean,
    checkUsage: boolean,
    checkDependencies: boolean,
    customRules: AuditRule[]
  })
  ```

- [ ] **Task 5.3**: Add `figma_get_token_coverage()` tool
  ```javascript
  figma_get_token_coverage({
    nodeId?: string,  // Component or page
    detailed: boolean
  })
  ```

- [ ] **Task 5.4**: Add `figma_find_hardcoded_values()` tool
  ```javascript
  figma_find_hardcoded_values({
    nodeId?: string,
    valueType?: 'color' | 'spacing' | 'typography' | 'all',
    suggestTokens: boolean
  })
  ```

### Phase 5.6: Testing & Documentation (Week 6)

- [ ] **Task 6.1**: Unit tests for enrichment modules
  - Test style resolver
  - Test relationship mapper
  - Test format exporters
  - Test auditing functions

- [ ] **Task 6.2**: Integration tests with real Figma data
  - Test with Altitude Design System
  - Test with complex variable structures
  - Test performance with large files
  - Test edge cases and error handling

- [ ] **Task 6.3**: Update documentation
  - Document new enriched response formats
  - Add export format examples
  - Add auditing workflow guides
  - Update README with Phase 5 features

- [ ] **Task 6.4**: Create example workflows
  - Design system audit workflow
  - Token export workflow
  - Component coverage analysis workflow
  - Migration to token-based system workflow

## Success Metrics

1. **Enriched Data Quality**
   - ✅ 100% of styles include resolved values
   - ✅ Component usage tracking with <1% error rate
   - ✅ Variable dependency resolution handles 5+ levels deep

2. **Export Accuracy**
   - ✅ CSS/Sass/Tailwind exports match Figma values exactly
   - ✅ TypeScript exports have full type safety
   - ✅ All export formats validated against test fixtures

3. **Audit Coverage**
   - ✅ Detect 100% of unused tokens
   - ✅ Identify all hardcoded values vs token usage
   - ✅ Catch circular references and orphaned variables

4. **Performance**
   - ✅ Enriched responses add <500ms overhead
   - ✅ Cache frequently accessed data
   - ✅ Handle files with 1000+ tokens/components

5. **Developer Experience**
   - ✅ Backward compatible with existing tools
   - ✅ Clear, actionable audit reports
   - ✅ Multiple export formats work out of box
   - ✅ Comprehensive error messages and debugging

## Technical Considerations

### Performance Optimization
- **Caching strategy**: Cache resolved values, relationship maps
- **Lazy loading**: Only enrich when `enrich: true` parameter passed
- **Batch processing**: Process multiple entities in single pass
- **Incremental updates**: Update cache on file changes

### Backward Compatibility
- Make enrichment **opt-in** via parameter: `enrich: true`
- Existing API responses unchanged by default
- Add new tools rather than modify existing ones
- Version enriched response format for future changes

### Error Handling
- Graceful degradation when enrichment fails
- Return partial data rather than complete failure
- Clear error messages for missing permissions
- Log enrichment failures for debugging

### Scalability
- Handle large design systems (1000+ tokens)
- Efficient graph algorithms for dependencies
- Stream large export outputs
- Paginate audit results for huge files

## Phase 5 Deliverables

1. **Enhanced API Tools**
   - `figma_get_styles()` with enrichment
   - `figma_get_variables()` with enrichment
   - `figma_get_component()` with enrichment
   - `figma_get_file_data()` with enrichment

2. **New Audit Tools**
   - `figma_audit_design_system()`
   - `figma_get_token_coverage()`
   - `figma_find_hardcoded_values()`

3. **Export Tool**
   - `figma_export_tokens()` with 5 format options

4. **Documentation**
   - Updated API documentation
   - Audit workflow guides
   - Export format examples
   - Migration guides

## Next Steps

1. Review and approve this Phase 5 plan
2. Begin with Phase 5.1: Foundation
3. Implement incrementally with testing at each phase
4. Merge to main when complete and tested

---

**Timeline**: 6 weeks
**Start Date**: TBD
**End Date**: TBD
**Status**: Planning
