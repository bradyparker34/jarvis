-- The four arenas. Edit the labels, keep the ids: adapters reference them.
--
-- Bitdeer runs at 'confidential' and is marked unshareable. That means a
-- cross-space query never reaches it by accident; only a query that names
-- 'bitdeer' outright can read it. If the employment question ever turns, one
-- DELETE on this row takes the whole space with it.

INSERT INTO spaces (id, label, description, default_sensitivity, shareable) VALUES
  ('bitdeer',    'Bitdeer',
   'Employment: Joint Mining Agreements and Sealminer hardware sales.',
   'confidential', false),

  ('lawrence',   'Lawrence / Meat',
   'Chicken brokering and MeatTrader Pro.',
   'private', true),

  ('scottsdale', 'Scottsdale Watch',
   'Luxury watch trading, WRI-MT LLC, WatchTrader Pro.',
   'private', true),

  ('personal',   'Personal',
   'Everything else: 34 Ventures, Adapt Nutrition, Servant Provisions, people, health, travel.',
   'private', true)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description;
