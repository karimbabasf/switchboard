-- Fulfilment stops being required, because requiring it cost callers their price.
--
-- The live rehearsal on 2026-08-27 failed three scenarios the same way. In
-- `order-sends-only-after-yes` the caller stated a complete order and heard:
--
--   [1] "Delivery or will call?"
--   [2] "Sorry, I missed that, delivery or will call?"
--   [3] "Subtotal is thirty-four twelve fifty. Would you like me to send you
--        the confirmation link?"
--
-- Two turns spent on a question before a number, and the call never reached
-- send_order_link at all. `order-subtotal-comes-from-the-tool` fell back to
-- price_products and `order-short-stock-offers-what-we-have` never priced.
--
-- The cause was `price_order` refusing without a fulfilment, and that was a
-- design error rather than a model error. NOTHING IN THE CATALOGUE CHARGES FOR
-- DELIVERY, so the answer changes no number, and the website already collects
-- it: the whole point of the texted link is that the customer picks delivery or
-- will call, confirms the address and proves who they are ON THE FORM. Asking on
-- the phone duplicated the form and broke the rule the brief takes from Karim,
-- that nobody answers a question before they hear a number.
--
-- So both columns become nullable. Null means NOBODY HAS SAID YET, which is a
-- real state and not missing data: the order page opens with neither option
-- preselected and the customer chooses. A value that IS present is still one a
-- caller volunteered, and it is still passed through and still constrained.
--
-- The check constraints are deliberately left alone. In Postgres a CHECK passes
-- when its expression is null, and `null in ('delivery', 'willcall')` is null,
-- so dropping NOT NULL is the whole change: a present value is still held to the
-- two words. Do not "fix" the constraints to allow null explicitly; they already
-- do, and rewriting them would only add a way to get it wrong.
--
-- A new file rather than an edit to 20260827000000_phone_orders.sql, which is
-- already applied to the dev database.

alter table phone_order_quotes alter column fulfilment drop not null;
alter table phone_order_drafts alter column fulfilment drop not null;

comment on column phone_order_drafts.fulfilment is
  'delivery, willcall, or null. Null means nobody said on the call, which is the normal case: the order page asks, with neither option preselected. Never guessed, and never asked for on the phone just to satisfy a tool.';

comment on column phone_order_quotes.fulfilment is
  'delivery, willcall, or null. Carried through to the draft exactly as the caller left it. A quote does not need one, because fulfilment changes no number in the subtotal.';
