# Google Voice: personal number port-out + Takeout export reference

Researched 2026-07-27 against live sources (support.google.com, knowledge.workspace.google.com, support.telnyx.com, telnyx.com, github.com, pypi.org). Anything not directly stated in an official Google/Telnyx page is marked **UNVERIFIED** or **ANECDOTAL**.

---

## PART A: PORT-OUT

### 1. Unlock steps and fee

Source: [support.google.com/voice/answer/1065667](https://support.google.com/voice/answer/1065667?hl=en) (personal accounts only; Workspace accounts use a different flow, see below).

1. On desktop, open voice.google.com.
2. Top right: gear icon, then **Settings**.
3. Go to the **Account** section.
4. Under the number you want to port, click **Unlock**.
5. Complete payment with your Google Account.
6. "Number unlocked" confirmation appears bottom-left.

**Fee: $3 USD.** Waived if the number was originally ported into Google Voice from another carrier (i.e., you only pay if the number is Google-native, assigned by Google itself).

Unlocking is a prerequisite, not the port itself: the port is then initiated from the new (winning) carrier's side, not from Google.

### 2. What the new carrier needs, and where each item comes from

This is the most common failure point per Google's own troubleshooting section ("Carrier info doesn't match").

| Field | Personal GV account | Where to find it |
|---|---|---|
| Phone number to port | Your 10-digit GV number | (n/a) |
| **Account number** | **Your 10-digit Google Voice phone number itself**: GV has no separate account-number field for personal accounts | Google states this explicitly: "provide your 10-digit Google Voice phone number and the PIN you use to access your Google Voice voicemail" |
| **PIN / passcode** | **Your Google Voice voicemail PIN** (the PIN you dial to access voicemail, not your Google Account password) | Set/view under GV Settings, Voicemail. If forgotten, reset it there before starting the port. |
| Account owner name | Name on the Google Account | (n/a) |
| Service/billing address | Address on file with Google Payments for that account | Not explicitly documented for personal accounts in the official page; expect to need the billing address tied to your Google payments profile. |

If your carrier's form asks for a generic "account number + PIN" (Republic Wireless, Cricket, Metro PCS style forms), Google's guidance is identical: number = account number, voicemail PIN = PIN.

**Google Workspace / business GV accounts differ:**
- Account number = **Account ID**, found in Admin console: Billing, then Payment accounts.
- PIN/port-out code: Admin console: Apps, Google Workspace, Google Voice, **Number porting**, then **Port-out info**. This generates the validation code the losing side needs; there is no voicemail-PIN equivalent for business accounts.

**Google's own troubleshooting checklist when the carrier reports "info doesn't match":**
- No typos; no abbreviations/special characters.
- Enter account number without dashes.
- Use the account owner's info if on a family plan (not a secondary user's).
- Enter billing address with numeric values first (street number before street name, in the field Google expects).
- Clear cache/cookies, wait 24h, retry if the port is stuck.

### 3. Underlying carrier and rejection risk

**ANECDOTAL/UNVERIFIED (industry-sourced, not confirmed in Google's own docs I fetched):** Bandwidth Inc. is widely reported as Google's underlying telephony/CLEC partner for number provisioning. Google's own Workspace docs refer to this partner only obliquely as the "GTSP" (Google Telephony Service Provider) that "processes the porting request upon notification from the new service provider." I could not find an official Google page that names Bandwidth directly: treat this as well-informed community/industry knowledge, not confirmed fact, before relying on it operationally.

What Google's own docs do confirm as rejection risk: GV numbers are not treated as standard wireless-carrier numbers by every downstream port-validation system, which is a common source of "info doesn't match" rejections. Also officially flagged: "Some third-party services may not accept phone numbers which originated from Google Voice, including after they have been ported to Google Fi Wireless."

### 4. Timeline, and what happens to the number during the port

- Google Workspace FAQ (general, not GV-out specific): U.S. number porting is regulated at no less than 10 business days and no more than 30, absent technical issues. This is stated in the context of porting into Voice, but the same FCC-driven floor/ceiling governs porting generally.
- Telnyx's own SLA (receiving-carrier side, applies if Telnyx is your new carrier): a simple port (single line, under 20 numbers, no reseller, no complex switch translations, a personal GV number qualifies) is submitted to the losing carrier within 2 business days, estimated completion about 7 business days. Non-simple ports (over 20 numbers or multi-line) run 15+ business days.
- **UNVERIFIED exact figure for the personal port-out page specifically**: Google's own port-out article does not state a fixed day count for personal accounts; it just says to track progress under Settings, Account, "Track your progress."
- **During the port:** your GV number keeps working normally until the port completes. The moment it completes, the number is automatically removed from your carrier account (Google's phrasing, read in context as: automatically removed from Google Voice) and any associated mobile plan may be canceled by the carrier. Google Voice does not offer a mobile plan itself, so if the ported number was your only working line, you need a new SIM/plan from the winning carrier to actually receive calls on a phone; you can then re-add that new number into GV as a linked number to keep using the GV app/interface.
- **Do not cancel your old service or Google Voice before the new carrier confirms the port is complete**: Google explicitly warns, "the port request will not succeed and the number might get lost," if you cancel prematurely.

### 5. What's lost or kept permanently

- **Your Google Voice account itself is not deleted.** GV assigns every account an "initial"/original number; within 90 days after porting your personal number out you're given a choice about keeping your original Google Voice number (the official page's exact wording on what that choice entails was cut off mid-fetch; confirm the full options at support.google.com/voice/answer/1065667 before acting, since this is the one part of the flow I could not fully verify verbatim).
- **SMS/MMS/call history:** stored against your Google Account, not the phone number; Takeout export remains available regardless of port status. Whether the live conversation thread stays visible inside the Voice web/app UI after the number is gone is **ANECDOTAL** (forum reports say historical threads persist), not something Google's docs state outright.
- **Voicemail:** the voicemail box tied to the ported number moves with the number to the new carrier; the GV voicemail box for that specific number goes away from Google's side.
- **MFA/2FA codes sent to the number:** **ANECDOTAL/inferred, not documented by Google.** Once ported, SMS/calls to that number go to the new carrier's physical SIM, not to the Google Voice app. If you were reading 2FA codes through the GV web UI without a physical phone, you lose that convenience unless you get a physical device on the new carrier or re-link the new number back into GV.
- **Google Account linkage:** unaffected; porting the phone number is independent of your Google Account login/security, unless that number was specifically set as your account-recovery phone (ordinary Google Account settings, not a GV-specific mechanic).

### 6. Porting a GV number to Telnyx specifically

Telnyx port-in steps ([support.telnyx.com/en/articles/1130634](https://support.telnyx.com/en/articles/1130634-port-numbers-to-telnyx), [.../1130630](https://support.telnyx.com/en/articles/1130630-porting-policy-procedure)):

1. Create a Telnyx Mission Control account, go to the **Port Numbers** page in the portal.
2. Enter the number(s) to port (one port request per underlying service provider/end customer).
3. Provide the **Phone Service Contact** (service address on file with the losing carrier) and the **Authorized Person's Name**: must match what the losing carrier (Google) has on file, i.e. your Google Account name.
4. Provide two documents:
   - **LOA** (Letter of Authorization) signed by you, listing all numbers being ported, with a wet signature or DocuSign-equivalent e-signature.
   - **Most recent bill copy** from the existing carrier. GV has no traditional PDF bill; Telnyx's own fallback options apply: a screenshot of the carrier portal showing the number(s) on the account, a CSR (Customer Service Record), or contacting porting@telnyx.com directly to work out an alternative.
5. Choose a default Connection to receive the number once ported.
6. You may request a FOC (Firm Order Commitment) date but it's not guaranteed; the losing carrier can override it.

Classification: a single personal GV number is a simple port by Telnyx's own FCC-aligned definition (single line, under 20 numbers, no reseller, no complex switch translations), submitted to Google within 2 business days, about 7 business day estimated completion.

Telnyx's number-type-specific requirements page only explicitly calls out **Wireless Numbers** (PIN may be required, last 4 of SSN may be requested); it does not have a distinct "Google Voice" or "VoIP" category, so it is **UNVERIFIED** exactly how Telnyx's intake system classifies a GV number (as VoIP/CLEC vs. wireless-equivalent). Expect to supply the account-number-is-the-phone-number plus voicemail-PIN combination Google itself defines, plus whichever bill-copy alternative Telnyx accepts.

Most common causes of porting delays/rejections at Telnyx (their own list): misspelled end-customer name, incorrect service address, bundling multiple end customers' numbers in one request, one of the numbers being inactive, missing account number.

### 7. Failure and rollback

- If a port is rejected for mismatched info, both sides let you correct and resubmit rather than starting over from scratch: Google's Settings, Account, Track your progress lets you edit/resubmit account info; Telnyx's portal shows the rejection reason and lets you refile.
- **The single biggest rule to avoid permanent loss:** don't cancel/deactivate Google Voice or your old service until the new carrier confirms the port completed. Cancelling early is explicitly called out by Google as the way "the number might get lost."
- Google Voice does have a "release and reclaim a Voice number" mechanism with a 30-day recovery window, but this applies specifically to a number you deliberately release from inside your own GV account settings, not to a number stuck in a failed/rejected port-out request. Don't conflate the two; there is no documented equivalent 30-day safety net for a rejected port-out.

---

## PART B: TAKEOUT EXPORT

### 8. Export structure and formats

The Google Voice Takeout format is not officially documented by Google: every parser project found here explicitly says this is reverse-engineered (direct quote from the most-maintained parser's README: "the actual format used by Google Takeout is not documented... pulling information out of those HTML files is just reverse engineering... there are many special cases").

Confirmed structure from multiple independent parser projects:
- Takeout produces a ZIP containing a `Voice/Calls/` directory with one HTML file per conversation/call/voicemail event, using microformat markup (hCard/hAtom style CSS classes) meant for browser display, not machine parsing.
- Voicemails and greetings export as MP3 audio files, referenced/embedded from the corresponding HTML file.
- Text messages (SMS/MMS) export as HTML using the same per-file convention; MMS/group threads and attachments are handled as special cases within the HTML.
- A forwarding-number vCard (.vcf) is included for linked numbers.
- No native JSON. No native mbox (mbox is Gmail's format, not Voice's). Any JSON/XML/CSV/SQLite output seen referenced online comes from third-party conversion tools run after Takeout, not from Google itself.
- Google Chat data (if exported alongside) comes as separate JSON under a `Google Chat/Groups/` directory, distinct from the Voice HTML files, though some parsers (e.g. gvoice-sms-takeout-xml) merge both into one output.

### 9. Timestamp and phone-number representation, plus parsing pitfalls

- **Timestamps:** each event is wrapped as `<abbr class="published" title="2011-03-05T18:33:56.000Z">Mar 5, 2011 10:33:56 AM</abbr>`. The `title` attribute is the machine-parseable value, in ISO-8601 UTC (note the `Z` suffix). The visible text node is localized to whatever timezone was active on the Google Account, with no offset shown in the text itself.
  - **Pitfall:** naive parsers that scrape the visible text instead of the `title` attribute get an ambiguous local time with no timezone info attached; dangerous across DST boundaries or if the account's timezone changed over the years. Always parse the `title` attribute; it's already normalized to UTC.
  - Filenames also embed a UTC-based timestamp in the form `2020-05-01T12_00_00Z` (colons replaced with underscores for filesystem safety); useful for correlating attachments to messages, but one HTML file can contain an entire multi-message thread, so the filename timestamp is not authoritative for every message inside it, only the per-message `abbr` tag is.
- **Phone numbers:** each sender is wrapped as `<cite class="sender vcard"><a class="tel" href="tel:+15551234567">display text</a></cite>` (hCard "tel" property).
  - **Pitfall:** if the number is a saved Google Contact, the visible text is the contact's display name, not the number; the actual E.164 number only lives in the `href="tel:...">` attribute. Group MMS threads have multiple such blocks, one per participant. Blocked/unknown callers may have no `tel` href at all, or show a placeholder like "Unknown."
- Net takeaway for a DB-seeding parser: never trust visible text for either timestamp or number, always pull from the `title`/`href` attributes, and build fixtures from a real sample export early since edge cases (group MMS, missing numbers, multi-day threads in one file) are common and undocumented.

### 10. Reusable open-source parsers (ranked by recency, verified via GitHub/PyPI API)

| Repo | Last push | Stars | Language | Output | Notes |
|---|---|---|---|---|---|
| **[moshekaplan/google-voice-takeout-parser](https://github.com/moshekaplan/google-voice-takeout-parser)** | **2026-07-20** (7 days ago) | 1 | Python | ndjson (one JSON object per conversation: type, participants with number, ISO8601 timestamps with offset, sender_number, content, image refs) or **SQLite** (`conversations`/`participants`/`messages`/`images` tables) | Also on PyPI as `google-voice-takeout-parser`, latest release v0.1.5 uploaded 2025-11-04. Best fit for seeding a database; output shape is close to a ready-made schema. Very low star count/small community; read the source before trusting it on messy real-world exports. |
| [wjcarpenter/gvoice-sms-takeout-xml](https://github.com/wjcarpenter/gvoice-sms-takeout-xml) | 2025-01-07 | 5 | Python | XML compatible with the Android "SMS Backup and Restore" app; 4 output files (sms, calls, sms-vm for voicemail as MMS with transcript, sms-chat for Google Chat) | 4th-generation fork (calyptecc, then karlrees, then wjcarpenter) with years of accumulated edge-case fixes; most battle-tested option, but would need an XML to DB translation step. |
| [psanford/google-voice-takeout-parser](https://github.com/psanford/google-voice-takeout-parser) | 2024-09-25 | 1 | Go | ndjson or SQLite directly from HTML | Very similar output shape to moshekaplan's tool; not touched in about 10 months. |
| [alexdelorenzo/parse_google_sms](https://github.com/alexdelorenzo/parse_google_sms) | 2021-08-24 | 22 (highest) | Python | Plain text files | Most-starred but stale about 5 years; framed as a forensics/recovery tool. |
| [r-barnes/gvoiceParser](https://github.com/r-barnes/gvoiceParser) | 2019-02-17 | 15 | Python 2.7 | SQLite | Stale, Python 2.7 with `html5lib`/`dateutil` deps; would need a Py3 port. |
| calebleung/t2sbr, thallium205/Google-Voice-to-CSV | 2016, 2011 | 2, 6 | Python, Java | XML / CSV | Effectively abandoned; listed for completeness only. |

**Recommendation:** start from `moshekaplan/google-voice-takeout-parser` (freshest by a wide margin, output shape matches a DB-seeding use case directly) and cross-check its parsing logic against `wjcarpenter/gvoice-sms-takeout-xml`'s HTML-quirk handling for edge cases before trusting it on a full real export.

---

## Sources
- https://support.google.com/voice/answer/1065667?hl=en
- https://support.google.com/voice/thread/10575079
- https://support.google.com/voice/thread/345972711
- https://knowledge.workspace.google.com/kb/how-to-port-out-your-voice-number-in-google-workspace-000008035
- https://knowledge.workspace.google.com/admin/voice/number-porting-requirements-for-google-voice
- https://knowledge.workspace.google.com/admin/voice/google-voice-porting-faq
- https://support.telnyx.com/en/articles/1130630-porting-policy-procedure
- https://support.telnyx.com/en/articles/6460777-porting-requirements
- https://support.telnyx.com/en/articles/1130634-port-numbers-to-telnyx
- https://telnyx.com/resources/letters-of-authorization
- https://www.bandwidth.com/blog/7-most-common-reasons-your-port-order-is-rejected/
- https://github.com/moshekaplan/google-voice-takeout-parser (plus PyPI)
- https://github.com/wjcarpenter/gvoice-sms-takeout-xml
- https://github.com/psanford/google-voice-takeout-parser
- https://github.com/alexdelorenzo/parse_google_sms
- https://github.com/r-barnes/gvoiceParser
- https://github.com/theopolisme/voice2json
- https://gist.github.com/NeighborGeek/84d578de2bc5538bd8d1
