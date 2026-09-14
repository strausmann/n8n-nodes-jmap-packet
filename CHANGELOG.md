## [1.1.0](https://github.com/strausmann/n8n-nodes-jmap-packet/compare/v1.0.1...v1.1.0) (2026-09-14)

### Features

* **credentials:** require https for the JMAP server ([8b96445](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/8b964458835b8bb73b7761c6b84064b74122db1b))
* **trigger:** add a push trigger using JMAP push subscriptions ([c0acefb](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/c0acefbe049ed42f677fa45b288bb9356d964fef))

### Bug Fixes

* **filter:** survive an attachment that arrives without a type ([3f1606f](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/3f1606f5bb35f660228bb4b4e639fd22bdbe4bcc))
* **jmap:** drop the origin check, keep the transport guarded ([5c0bd23](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/5c0bd2368226a2e4834dd62a78efbcedfd5cf378))
* **jmap:** pin session URLs to the configured origin ([6608a34](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/6608a340e1be26992fca6f64321cf8e3235f54b8))
* **push-trigger:** ask the server what changed instead of guessing from a clock ([e26d848](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/e26d84826711b6501475dc089f5ef41b7becb064))
* **push-trigger:** stop trusting the request body of an open endpoint ([1a4ffd6](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/1a4ffd6f7be972bf9f64256d752e2994fb49e0f3))
* **trigger:** stop losing mail, and start watching from activation ([3161e33](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/3161e33109a3548654c0319903c8c966b997f731))

## [1.0.1](https://github.com/strausmann/n8n-nodes-jmap-packet/compare/v1.0.0...v1.0.1) (2026-09-13)

### Bug Fixes

* **release:** stop commenting on issues this repository does not have ([5cec681](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/5cec6810700d2c3464afdc65722a15ac32eaad20))

## 1.0.0 (2026-09-13)

### Features

* **trigger:** let the trigger filter which emails it fires on ([92e0e18](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/92e0e1880d2bf70e41a4305a37067d6aa6ac75b4))

### Bug Fixes

* **ci:** drop registry-url so npm auth reaches semantic-release ([1ab1b78](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/1ab1b78d06cd743ea59722db56d3aea988ba6f29))
* **release:** declare public access so provenance can be generated ([94bd1b3](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/94bd1b3af5c5ca352a704f75427f1adc90df2465))
* **release:** pin conventional-changelog-writer forward to 9.x ([8ccb659](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/8ccb659d1adb48d8a554c4e295dd421daea76d4b)), references [semantic-release/release-notes-generator#1021](https://github.com/semantic-release/release-notes-generator/issues/1021)
* send method calls to the session's apiUrl (fixes [#17](https://github.com/strausmann/n8n-nodes-jmap-packet/issues/17)) ([5fe3736](https://github.com/strausmann/n8n-nodes-jmap-packet/commit/5fe373696f2e9e8942aa6d3bd4db23dbbdbcb04d))
