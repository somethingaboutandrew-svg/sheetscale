# Submitting PlanMark to the Mac App Store

This is the step-by-step checklist for Andrew. Everything that could be prepared without your Apple
account is already in this repo. Steps marked **[You]** need your Apple ID, your Mac or a decision
from you. Steps marked **[Mac]** run in Terminal on your Mac.

What is already done:

| Item | Where |
|---|---|
| Mac App Store build config (universal, App Sandbox, macOS 12+, encryption flag, category) | `desktop/package.json` → `build.mac`, `build.mas`, `build.masDev` |
| Sandbox entitlements (main app + helpers) | `desktop/build/entitlements.mas.plist`, `desktop/build/entitlements.mas.inherit.plist` |
| Acknowledgements (all open-source licenses) | in the app: Help > Acknowledgements and the start-screen footer; file: `THIRD_PARTY_LICENSES.txt` |
| Privacy policy and support pages | https://somethingaboutandrew-svg.github.io/planmark/privacy.html and …/support.html |
| Listing text, keywords, age rating, App Privacy answers, review notes | `appstore/METADATA.md` (and `appstore/metadata.json`) |
| Screenshots, 2880 × 1800 | `appstore/screenshots/` (9 files, upload in file-name order) |
| Sample PDF for Apple's reviewers | `appstore/review/PlanMark-review-sample.pdf`, also at https://somethingaboutandrew-svg.github.io/planmark/samples/sample-plan.pdf |
| App icon | `desktop/build/icon.png` is 1024 × 1024; the build turns it into `icon.icns` with the 1024 px (512@2x) size Apple requires |

---

## 0. Decide the name first **[You]**

"PlanMark" is not safe to launch under (details in the launch-plan Page):

- **USPTO:** OCUBUILD, LLC has a pending application for **PLANMARK** (serial 99865963) and **PLANMARK BY OCUBUILD** (99865968), for construction-plan drawing software in classes 9 and 42. Look them up at https://tmsearch.uspto.gov/ by those serial numbers.
- **App Store:** "Planmark Room Scanner" (iPhone, LiDAR floor plans with PDF export) is already listed: https://apps.apple.com/us/app/planmark-room-scanner/id6782553911
- **Web:** Planmark Oy (planmark.io) sells ESG-reporting software.

Pick a new name **before** you create the App Store Connect record, because the bundle ID can never change afterwards. Candidates that had no USPTO record and no App Store app with that name on 31 Oct 2026: **SheetScale**, **PlanTally**, **MarkScale**. A trademark attorney's clearance search is still worth it before you spend on marketing.

When you've chosen, tell Grok Bot. The rename touches the app's title, the logo text, the window title, `productName`, the bundle ID, the web pages and the screenshots, and it can be done in one pass. The steps below say "PlanMark" and `com.andrewpocta.planmark`; replace both with the new name.

## 1. Business setup in App Store Connect **[You]**

1. Sign in at https://appstoreconnect.apple.com → **Business** (older accounts: Agreements, Tax, and Banking). Accept the **Paid Apps** agreement, then add your bank account and complete the US tax form (W-9). Until this shows **Active**, you cannot sell a paid app.
2. Enroll in the **App Store Small Business Program**: https://developer.apple.com/app-store/small-business-program/. Apple then takes 15% instead of 30% while your proceeds stay under $1 million a year. It takes effect from the start of the next fiscal month after approval, so do it now.
3. Note your **Team ID**: https://developer.apple.com/account → Membership details (10 characters, e.g. `AB12CD34EF`).

## 2. App ID **[You]**

https://developer.apple.com/account/resources/identifiers/list → **+**

1. **App IDs** → Continue → type **App** → Continue.
2. Platform **macOS**. Description: `PlanMark`. Bundle ID: **Explicit**, `com.andrewpocta.planmark`.
3. Capabilities: leave everything unticked. PlanMark needs none, and the App Sandbox is set by the entitlements file, not here.
4. Continue → Register.

## 3. Certificates **[You] [Mac]**

The easiest way is Xcode (free from the Mac App Store):

1. Xcode → **Settings… → Accounts** → add your Apple ID → select your team → **Manage Certificates…**
2. Click **+** and add **Apple Distribution**, then **+** again and add **Mac Installer Distribution**. Also add **Apple Development**, which you need for the test build in step 6.
3. Check in Terminal that all three are in your keychain:

       security find-identity -v -p codesigning     # shows Apple Distribution and Apple Development
       security find-identity -v                     # also shows 3rd Party Mac Developer Installer / Mac Installer Distribution

## 4. Register your Mac as a test device **[You]**

Only needed for the sandbox test build in step 6.

1. Apple menu → **About This Mac → More Info → System Report** → Hardware → copy **Provisioning UDID**.
2. https://developer.apple.com/account/resources/devices/list → **+** → Platform macOS → name it → paste the UDID → Register.

## 5. Provisioning profiles **[You]**

https://developer.apple.com/account/resources/profiles/list → **+**

1. **Distribution → Mac App Store Connect** → App ID `com.andrewpocta.planmark` → certificate **Apple Distribution** → name `PlanMark MAS` → Generate → Download. Save it as:

       planmark/desktop/build/embedded.provisionprofile

2. **Development → macOS App Development** → same App ID → your **Apple Development** certificate → your Mac → name `PlanMark Dev` → Download. Save it as:

       planmark/desktop/build/development.provisionprofile

Both file names are in `.gitignore`, so they stay on your Mac and are never committed.

## 6. Get the code and test the sandboxed build on your Mac **[Mac]**

Install Node.js 20 or later (https://nodejs.org, LTS) if you don't have it. Then:

    git clone https://github.com/somethingaboutandrew-svg/planmark.git
    cd planmark
    npm ci && npm run build
    cd desktop && npm ci
    npm run dist:mas-dev          # Apple Development signed, sandboxed, arm64
    open release/mas-dev-arm64/PlanMark.app

Then check these in the app. They prove the App Sandbox build works, which could only be checked on a Mac:

- [ ] Activity Monitor → right-click the column header → add **Sandbox**. PlanMark shows **Yes**.
- [ ] File > Open… opens a PDF from Documents, Desktop and an external drive.
- [ ] Drag a PDF from Finder onto the window, and onto the Dock icon. Both open.
- [ ] Measure something, then File > Save. Save the file next to the original, and check that the saved file opens in Preview.
- [ ] File > Save As / Flatten…, File > Combine PDFs… and File > Reduce File Size… each work and save.
- [ ] Quit, reopen: the start screen lists the recent file, and it reopens with its markups (IndexedDB autosave in the sandbox container).
- [ ] Help > Acknowledgements and Help > Chromium Licenses open. Help > Privacy Policy opens Safari.
- [ ] Turn Wi-Fi off and repeat one open, measure and save. Everything still works.

If anything fails, copy the error from **Console.app** (filter by "PlanMark" or "sandbox") and send it to Grok Bot.

## 7. Build the signed upload package **[Mac]**

From `planmark/desktop`:

    npm run dist:mas

This builds a **universal** (Apple Silicon + Intel) app with Electron's Mac App Store build. It is signed with **Apple Distribution**, wrapped in a `.pkg` signed with **Mac Installer Distribution**, and the `embedded.provisionprofile` from step 5 goes inside it. electron-builder adds the required `com.apple.security.application-groups` entitlement (`<TeamID>.com.andrewpocta.planmark`) and `ElectronTeamID` automatically from your certificate. The result is:

    desktop/release/mas-universal/PlanMark.app
    desktop/release/PlanMark-1.1.0-mas.pkg

Optional checks:

    pkgutil --check-signature release/PlanMark-1.1.0-mas.pkg      # signed by 3rd Party Mac Developer Installer / Mac Installer Distribution
    codesign -d --entitlements - release/mas-universal/PlanMark.app   # app-sandbox, user-selected.read-write, application-groups

Every upload needs a new build number. For the next upload of the same version, use:

    npm run dist:mas -- -c.buildVersion=2

## 8. Create the app record **[You]**

App Store Connect → **Apps → + → New App**:

- Platforms: **macOS**
- Name: from `appstore/METADATA.md` (or your new name)
- Primary language: English (U.S.)
- Bundle ID: `com.andrewpocta.planmark`
- SKU: `PLANMARK-MAC-001`
- User access: Full Access

## 9. Upload with Transporter **[You] [Mac]**

1. Install **Transporter** from the Mac App Store: https://apps.apple.com/us/app/transporter/id1450874784
2. Sign in with your Apple ID, drag in `PlanMark-1.1.0-mas.pkg`, and click **Deliver**.
3. Processing takes about 15–60 minutes. You get an email when the build is ready, or a list of problems if Apple's automated check rejects it. If you get the rejection email, forward it to Grok Bot.

## 10. Fill in the listing **[You]**

Copy everything from `appstore/METADATA.md`:

1. **App Information**: subtitle, categories (Productivity, then Business), content rights, age rating questionnaire (all None / No → 4+).
2. **App Privacy**: Privacy Policy URL → *Get Started* → "No, we do not collect data from this app" → Publish. The label reads **Data Not Collected**.
3. **macOS App → 1.1.0 Prepare for Submission**: screenshots (drag in `appstore/screenshots/` in order), promotional text, description, keywords, support URL, marketing URL, version, copyright.
4. **Build**: choose the build you uploaded. Export compliance is already answered by `ITSAppUsesNonExemptEncryption = false` in the app.
5. **App Review Information**: your name, phone and email; Sign-in required: **No**; paste the review notes; attach `appstore/review/PlanMark-review-sample.pdf`.
6. **Version Release**: choose **Manually release this version** so you control launch day.

## 11. Price **[You]**

**Pricing and Availability** → base country United States:

- Price: **$69.99**. Add a **scheduled price change** so the first two weeks are **$49.99** (start: launch day; end: launch day + 14) and it then returns to $69.99.
- Availability: all countries, or start with English-speaking ones.
- Leave the Volume Purchase / Apple Business Manager discount for organisations switched on.

The launch-plan Page explains this price.

## 12. Submit **[You]**

**Add for Review → Submit to App Review.** Review usually takes 1–3 days. Once it's approved, click **Release This Version** on your launch day.

If the review comes back with an issue, paste Apple's message to Grok Bot. Common Electron issues and their fixes:

- *2.5.1 private API use*: the build already uses Electron 45.2.1's Mac App Store build. Every symbol Apple has flagged in Electron apps before (NSKillRing, `_toolbarView`, `_CGSSetWindowCaptureExcludeShape`, `_CGRegionCreateWithRect`, `_CTFontCopyVariationAxesInternal`, …) was checked and is absent. The fix would be the next Electron patch release.
- *2.4.5 sandbox / entitlements*: only `app-sandbox` and `files.user-selected.read-write` are requested. If Apple asks why, the answer is in the review notes.
- *4.2 minimum functionality / web wrapper*: the review notes show the native menus, Open/Save panels, Finder Open With and offline use.
