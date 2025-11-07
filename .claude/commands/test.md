# Test Command

Run tests and ensure code quality for the Figma Console MCP server.

## Instructions

1. **Run Test Suite**
   ```bash
   npm test
   ```

2. **Watch Mode** (for development)
   ```bash
   npm run test:watch
   ```

3. **Coverage Report**
   ```bash
   npm run test:coverage
   ```

4. **Test Requirements**
   - All new code must have tests
   - Maintain 70%+ coverage threshold
   - Tests must pass before commits
   - Use descriptive test names

5. **Test Structure**
   - Unit tests: `src/**/*.test.ts`
   - Integration tests: `tests/**/*.test.ts`
   - Use Jest with ts-jest preset

## Example Usage

```
/sc:test
```

This will run the complete test suite and report results.
