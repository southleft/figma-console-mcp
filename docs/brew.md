# Publishing figma-cli to Homebrew

This document covers publishing the `figma-cli` Rust binary to Homebrew via a custom tap.

---

## Overview

Homebrew distribution uses a **tap** — a GitHub repository named `homebrew-<name>` containing Ruby formula files.

```
southleft/homebrew-figma-cli   ← tap repo
  └── Formula/
        └── figma-cli.rb       ← formula
```

Users install with:
```bash
brew tap southleft/figma-cli
brew install figma-cli
```

---

## One-time Setup

### 1. Create the tap repository

Create a new GitHub repository named **`homebrew-figma-cli`** under the `southleft` org:

```bash
gh repo create southleft/homebrew-figma-cli --public --description "Homebrew tap for figma-cli"
```

Initialize with the formula directory:

```bash
git clone https://github.com/southleft/homebrew-figma-cli.git
cd homebrew-figma-cli
mkdir Formula
# copy the formula template (see below)
git add Formula/figma-cli.rb
git commit -m "Initial formula"
git push
```

### 2. Create `HOMEBREW_TAP_TOKEN` secret

The release workflow updates the tap repo automatically. It needs a GitHub PAT with `repo` scope on the `southleft/homebrew-figma-cli` repository.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Create token with **Contents: Read and write** on `southleft/homebrew-figma-cli`
3. Add as repository secret: **`southleft/figma-console-mcp` → Settings → Secrets → `HOMEBREW_TAP_TOKEN`**

---

## Formula Template

The `rust-release.yml` workflow generates and commits this formula automatically. For manual releases, here is the template:

```ruby
class FigmaCli < Formula
  desc "CLI analog of figma-console-mcp — Figma REST API as shell commands"
  homepage "https://github.com/southleft/figma-console-mcp"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/southleft/figma-console-mcp/releases/download/figma-cli-v0.1.0/figma-cli-macos-aarch64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_AARCH64_ARCHIVE"
    else
      url "https://github.com/southleft/figma-console-mcp/releases/download/figma-cli-v0.1.0/figma-cli-macos-x86_64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_X86_64_ARCHIVE"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/southleft/figma-console-mcp/releases/download/figma-cli-v0.1.0/figma-cli-linux-aarch64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_LINUX_AARCH64_ARCHIVE"
    else
      url "https://github.com/southleft/figma-console-mcp/releases/download/figma-cli-v0.1.0/figma-cli-linux-x86_64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_LINUX_X86_64_ARCHIVE"
    end
  end

  def install
    bin.install "figma-cli"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/figma-cli --version")
  end
end
```

---

## Automated Release Flow

The `.github/workflows/rust-release.yml` workflow handles the full release cycle automatically:

```
push to main (figma-cli/** changed)
    │
    ▼
1. Detect version bump type from conventional commits
   fix: → patch  |  feat: → minor  |  feat!: → major
    │
    ▼
2. Build release binaries (GitHub Actions matrix):
   • macOS Apple Silicon (aarch64-apple-darwin)
   • macOS Intel       (x86_64-apple-darwin)
   • Linux x86_64      (x86_64-unknown-linux-gnu)
   • Linux aarch64     (aarch64-unknown-linux-gnu)
    │
    ▼
3. Bump Cargo.toml version, commit [skip ci]
    │
    ▼
4. Create GitHub release with .tar.gz archives
    │
    ▼
5. Update homebrew-figma-cli Formula/figma-cli.rb
   with new version + SHA256 checksums, push
```

### Triggering a release manually

If you want to release without a conventional commit message, push with an explicit bump:

```bash
# Trigger patch release
git commit --allow-empty -m "fix(figma-cli): trigger patch release"
git push
```

---

## Manual Release (without CI)

```bash
# 1. Build for all targets
cd figma-cli
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin

# 2. Package
tar czf figma-cli-macos-aarch64.tar.gz -C target/aarch64-apple-darwin/release figma-cli
tar czf figma-cli-macos-x86_64.tar.gz  -C target/x86_64-apple-darwin/release  figma-cli

# 3. Compute checksums
shasum -a 256 figma-cli-macos-*.tar.gz

# 4. Create GitHub release
gh release create figma-cli-v0.1.0 \
  figma-cli-macos-aarch64.tar.gz \
  figma-cli-macos-x86_64.tar.gz \
  --title "figma-cli 0.1.0" \
  --notes "Initial release"

# 5. Update tap formula
# Edit homebrew-figma-cli/Formula/figma-cli.rb with new version + SHA256
# Commit and push to southleft/homebrew-figma-cli
```

---

## Submitting to homebrew-core (future)

Once `figma-cli` has:
- **75+ stars** on the main repo
- **30-day release history**
- **Stable API** (v1.0.0+)

Submit to homebrew-core:
```bash
brew tap --force homebrew/core
brew create https://github.com/southleft/figma-console-mcp/releases/download/figma-cli-vX.Y.Z/figma-cli-macos-aarch64.tar.gz
# Edit the generated formula, then:
brew audit --new figma-cli
brew test figma-cli
gh pr create --repo homebrew/homebrew-core
```
