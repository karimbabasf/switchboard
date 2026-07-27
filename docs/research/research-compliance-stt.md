# Research: A2P 10DLC registration + STT provider comparison

Compiled 2026-07-27. Live-fetched from primary sources where noted; secondary/aggregator figures are flagged UNVERIFIED and should be re-checked against the primary pricing page before committing spend, since both 10DLC carrier fees and STT pricing change often.

---

## PART A: US A2P 10DLC registration (Telnyx, one long code, solo builder)

### 1. Is registration mandatory?

Yes, unconditionally, for any US long code sending A2P-style traffic (any volume above true 1:1 personal texting). Telnyx: "10DLC is the mandatory compliance framework for USA long-code SMS & MMS traffic." Unregistered traffic is not just a "surcharge tier" anymore, it is being phased out entirely: "Unregistered 10DLC traffic is ending permanently. Carriers have progressively increased pass-through fees for unregistered traffic and ramped up filtering before implementing full blocks. The February 2025 cutoff eliminates unregistered messaging entirely." As of today (July 2026) that cutoff has passed, so unregistered long-code SMS is filtered/blocked by carriers, not merely taxed.
Sources: [Telnyx FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc), [What is 10DLC](https://telnyx.com/resources/what-is-10dlc)

### 2. Sole Proprietor vs Standard Brand

| | **Sole Proprietor** | **Standard Brand** |
|---|---|---|
| Eligibility | No EIN; single individual operating a business; low-volume messaging | Any registered business, or a sole proprietorship that has an EIN/Canadian Business Number (TCR requires these to register Standard/Low Volume, not Sole Proprietor) |
| Info required | Legal name (matches ID), email (Gmail fine), SMS-capable mobile number (for OTP), physical address (no PO boxes), a URL (LinkedIn, FB page, personal site) showing legitimacy | Legal company name, country, organization type, EIN/Tax ID, business website, description plus sample messages per use case; nonprofits need 501(c)(3) cert, private entities may need licenses/incorporation docs |
| One-time cost | Brand registration $4.00 | Brand registration $4.50 |
| Per-submission cost | Campaign vetting $15.00 per submission/resubmission | Campaign review $15.00 per submission/resubmission; optional brand vetting to raise Trust Score, around $15+ (exact external vetting price beyond this wasn't confirmed, UNVERIFIED; third-party vetting vendors typically charge $40 to $95) |
| Monthly cost | $2.00/mo maintenance | $1.50/mo (Low Volume Mixed) up to $10/mo (Standard volume), $3/mo Charity, $5/mo Emergency use case; billed 3 months upfront, then monthly |
| Throughput / caps | 1 campaign per brand, 1 number per campaign, max 3 Sole Proprietor brands per mobile number (identity reuse cap), "low volume" throughput that "varies by carrier," typical guidance around 1,000 msgs/day | Scales with Trust Score; base is around 1 message/sec per number and climbs with vetting. T-Mobile enforces a daily cap at the brand level (all campaigns share it). Special T-Mobile Business Review required above 200,000 msgs/day/brand ($5,000 one-time, currently waived); T-Mobile Number Pool Request for 50+ numbers on one brand ($50 one-time) |
| Approval timeline | OTP identity verification: 24-hour window (email in, PIN texted back, email it back). Campaign carrier review: typically 3 to 7 business days | Similar carrier review cycle; 3 separate submissions overall (brand, then campaign, then number assignment) |

Sources: [Telnyx Sole Proprietor guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration), [Telnyx dev docs, Sole Proprietor](https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor/index), [10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges), [What is 10DLC](https://telnyx.com/resources/what-is-10dlc), [Brand registration guide](https://telnyx.com/resources/10dlc-brand-registration), [Sole Proprietor release note](https://telnyx.com/release-notes/10dlc-sole-proprietor-support)

Note: some third-party aggregators (Telgorithm, Signal House) state Sole Proprietor registration also asks for the last 4 digits of SSN/SIN. Telnyx's own published Step 1 field list (fetched above) does not list SSN, flag as a possible CSP-specific difference, not confirmed in Telnyx's UI copy.

### 3. Common rejection reasons (from Telnyx's own compliance requirements doc)

- Call-to-Action missing required disclosures: program/brand name, "message frequency may vary," "msg & data rates may apply," "reply STOP," "reply HELP," a Terms and Conditions link, a Privacy Policy link
- Opt-in, Opt-out, and Help radio buttons not all set to "True" in TCR: automatic rejection
- Brand website doesn't match brand name, isn't HTTPS-secured, or has broken links
- Phone number field on the website opt-in form is marked required instead of optional
- Enrolling a consumer in multiple messaging programs from a single opt-in
- Campaign submitted before the brand finished verification (shows as TCR ID starting "4b3" or "Failed TCR Review")
- Impermissible content (SHAFT: sex, hate, alcohol, firearms, tobacco): triggers fines/suspension even post-approval
- Sole Proprietor specifically: legal name or website contains terms implying an actual registered business; disqualifies Sole Proprietor entity type, forces Standard plus EIN instead

Source: [10DLC Campaign Compliance Requirements](https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements)

### 4. Carrier per-message surcharges (on top of Telnyx's own SMS price), registered 10DLC traffic

| Carrier | SMS | MMS |
|---|---|---|
| T-Mobile (incl. former Sprint) | $0.003 send and receive | $0.01 send and receive |
| AT&T | $0.003 to send, free to receive | $0.009 to send, free to receive |
| Verizon Wireless | $0.0045 to send, free to receive | Free both ways |

Source: [10DLC Fees and Charges, Registered Traffic table](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)

Telnyx's own base SMS price for a 10DLC long code is $0.004/message part (per Telnyx's own ISV comparison blog), separate from Telnyx's general messaging pricing page which lists $0.0045/part as the discounted-tier starting price for Toll-Free/Short Code sender types; the exact figure your account sees depends on sender type and volume tier, confirm at checkout. Telnyx does not mark up 10DLC carrier fees, they're passed through at cost.
Sources: [10DLC vs Toll-free for ISVs](https://telnyx.com/resources/10dlc-vs-toll-free-isvs), [Telnyx messaging pricing](https://telnyx.com/pricing/messaging)

Unregistered traffic: no longer just surcharged, carriers block it outright post-February-2025 cutoff (see item 1). Historical unregistered T-Mobile rate before the block was around 4x the registered rate (UNVERIFIED, secondary source).

### 5. Upgrading Sole Proprietor to Standard Brand without changing the number

Telnyx doesn't document a one-click "upgrade" button; Sole Proprietor and Standard are different TCR entity types, not tiers of the same brand. Telnyx's own release note is explicit that once a valid EIN exists, Sole Proprietor ("Starter") registration is no longer allowed for that business. The practical, documented mechanism: register a new Standard Brand plus Campaign using the EIN, then use the existing "assign numbers to your campaign" step to move the same physical long code number onto the new Standard campaign; the number itself never has to be re-ported or changed, only its brand/campaign linkage. (Reasoned from Telnyx's documented brand/campaign/number architecture, not an explicitly named "upgrade path" in their docs.)
Source: [Sole Proprietor release note](https://telnyx.com/release-notes/10dlc-sole-proprietor-support), [Sole Proprietor guide, Step 5](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration)

### 6. Toll-free verification as an alternative

| | 10DLC | Toll-Free |
|---|---|---|
| Registration cost | $4 base + $15/campaign + $15 optional brand vetting | $0, no Brand/Campaign, just Number Registration (single form or Telnyx's Toll-Free Verification API) |
| Monthly cost | $1/number + $2 to $10/mo per campaign | $1/number, no campaign fee |
| Per-message price | around $0.004/part | around $0.0055/part (higher) |
| Paperwork | 3 submissions (brand, campaign, number) | 1 submission |
| Approval time (numbers, as of April 2024, may be dated) | around 3 business days | around 5 business days |
| Throughput | Starts around 1 MPS/number, scales with Trust Score | Industry standard around 3 MPS/180 MPM per number; Telnyx cites up to 1,200 msgs/min per number in some contexts (UNVERIFIED against primary toll-free doc) |

Source: [10DLC vs Toll-free for ISVs](https://telnyx.com/resources/10dlc-vs-toll-free-isvs), [Toll-Free Messaging](https://support.telnyx.com/en/articles/5353868-toll-free-messaging)

Toll-free cannot be a ported personal mobile number: toll-free (8xx) is a distinct number block in the NANP from standard 10-digit mobile/long-code numbers; a personal mobile number can only port into a 10DLC-eligible long code slot, never into toll-free. Every Telnyx toll-free doc treats toll-free as "buy or lease a new number," never a port target. This is a numbering-plan fact rather than a specific citable Telnyx caveat.

For a solo builder porting a personal mobile number onto Telnyx: toll-free is not applicable (you can't port the personal number into it), so Sole Proprietor 10DLC on the ported long code is the only compliant path, and it's inexpensive ($4 + $15 + $2/mo) with same-day OTP verification and 3 to 7 business day campaign approval.

---

## PART B: Speech-to-text providers for recorded phone calls

### 7 to 8. Batch/pre-recorded pricing plus capability matrix

| Provider | Batch rate | Streaming rate | Multichannel (native) | Diarization | Formats | Max file / duration | Typical 10-min turnaround |
|---|---|---|---|---|---|---|---|
| Deepgram Nova-3 | around $0.0043/min (around $0.26/hr); secondary sourced, Deepgram's own pricing page is JS-rendered and didn't yield the number on static fetch, 6 independent trackers (smallest.ai, diyai.io, convertaudiototext.com, buildmvpfast.com, dynalord.com, brasstranscripts.com) converge on this figure | around $0.0077/min (around $0.46/hr) | Yes: `multichannel=true`, first-class documented feature, transcribes each channel independently; can combine with per-channel `speaker_labels` if a channel itself has multiple speakers | Yes, add-on (around $0.02/hr per secondary source) | WAV, MP3, and most common codecs (per docs) | Not confirmed in this pass | Not confirmed in this pass (Deepgram is generally the fastest of the three) |
| AssemblyAI | Universal-3.5 Pro (flagship) $0.21/hr (around $0.0035/min); Universal-2 $0.15/hr (around $0.0025/min); both primary, confirmed on assemblyai.com/pricing | Universal-3.5 Pro Realtime / Sync API $0.45/hr; Universal-Streaming $0.15/hr | Yes: `multichannel`/`dual_channel` param, transcribes each channel separately then merges into one transcript with per-utterance channel tags ("1"/"2"); around 25% longer processing for dual-channel jobs | Yes, +$0.02/hr add-on (async); can be combined per-channel with multichannel | Standard audio/video containers per docs | Not confirmed in this pass | Not confirmed in this pass |
| OpenAI Whisper API / gpt-4o-transcribe | whisper-1 and gpt-4o-transcribe: $0.006/min (around $0.36/hr); gpt-4o-mini-transcribe: around $0.003/min (around $0.18/hr); UNVERIFIED, OpenAI's own pricing page is token-metered for audio and the exact per-minute row wasn't extracted on this pass; figures corroborated by 5 independent trackers (diyai.io, costgoat.com, convertaudiototext.com, costbench.com, lmmarketcap.com) | gpt-realtime-whisper: $0.017/min (this one is primary-confirmed on platform.openai.com/docs/pricing) | No: the API downmixes any stereo/multichannel input to mono before transcribing, destroying channel separation (confirmed via OpenAI community/GitHub threads) | Not built in; needs prompting or external post-processing | Well-documented 25 MB file size cap (long-standing, high-confidence fact) | 25 MB, no explicit duration cap documented here | Not confirmed in this pass |

Other options surfaced (not independently verified against primary pricing pages, from AssemblyAI's own competitor-comparison table and Rev/Sonix trackers):
- Google Cloud Speech-to-Text: around $0.48/hr batch, around $0.96/hr streaming, diarization +$0.36/hr; pricier, EU data residency available.
- AWS Transcribe: around $1.44/hr both modes, diarization +$0.14/hr; most expensive of the group.
- Rev.ai: Reverb model $0.20/hr, hosted Whisper around $0.30/hr, Forced Alignment $0.003/min; UNVERIFIED, cheaper on paper but not confirmed on rev.ai's own pricing page this pass.
- Speechmatics: no pricing figure located this pass, not found.

### 9. Best pick for dual-channel phone recordings (each party already on its own channel, no diarization needed)

Both Deepgram and AssemblyAI treat multichannel as a first-class, named parameter (`multichannel=true` / `dual_channel`) that transcribes each channel independently and tags output by channel, exactly the mechanism this use case needs, with zero diarization required or billed. OpenAI's Whisper/gpt-4o-transcribe API is disqualified for this use case as-is: it silently downmixes stereo to mono, so a raw dual-channel call recording would need to be split into two mono files and sent as two separate API calls to preserve the channel split.

Between the two viable options: AssemblyAI Universal-2 async ($0.15/hr) is the cheapest fully-native multichannel option, cheaper than Deepgram Nova-3's aggregator-estimated around $0.26/hr batch rate, while Deepgram remains the pick if raw speed/accuracy on 8kHz telephony-band audio matters more than the around $0.10/hr premium (Deepgram markets multichannel as one of its signature, most mature features).

### 10. Free tier / minimum spend

- Deepgram: $200 free credit, no card required (primary-confirmed via pricing page FAQ; around 45,000 minutes per secondary conversion). Pay-as-you-go has no minimum; Growth (committed-spend) tier starts around $4,000/yr, UNVERIFIED secondary figure.
- AssemblyAI: free tier primary-confirmed: up to 185 hours pre-recorded / 333 hours streaming, no credit card required. No minimum spend on pay-as-you-go.
- OpenAI: no dedicated free tier for transcription; billed through standard API credits/usage.

---

## Sources index

- Telnyx: [Sole Proprietor guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration), [10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges), [10DLC FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc), [What is 10DLC](https://telnyx.com/resources/what-is-10dlc), [Brand registration steps](https://telnyx.com/resources/10dlc-brand-registration), [Messaging pricing](https://telnyx.com/pricing/messaging), [10DLC vs Toll-free for ISVs](https://telnyx.com/resources/10dlc-vs-toll-free-isvs), [Toll-free SMS vs 10DLC](https://telnyx.com/resources/toll-free-sms-vs-10dlc), [Toll-Free Messaging](https://support.telnyx.com/en/articles/5353868-toll-free-messaging), [Campaign compliance requirements](https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements), [Sole Proprietor release note](https://telnyx.com/release-notes/10dlc-sole-proprietor-support), [Sole Proprietor dev docs](https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor/index), [How to create a brand](https://support.telnyx.com/en/articles/5896911-how-to-create-a-10dlc-brand)
- STT: [Deepgram pricing](https://deepgram.com/pricing), [Deepgram multichannel docs](https://developers.deepgram.com/docs/multichannel), [AssemblyAI pricing](https://www.assemblyai.com/pricing), [AssemblyAI pricing blog (July 2026)](https://www.assemblyai.com/blog/speech-to-text-api-pricing), [AssemblyAI multichannel docs](https://www.assemblyai.com/docs/pre-recorded-audio/multichannel-transcription), [OpenAI platform pricing](https://platform.openai.com/docs/pricing)
