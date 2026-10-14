-- A skeleton so the map is not empty on day one, and so early ingestion has
-- something to attach to. Edit freely: these are starting points, not truth.
--
-- Safe to re-run.

INSERT INTO entities (kind, name, aliases, summary) VALUES
  ('org', 'Scottsdale Watch', '{"WRI-MT LLC","scottsdalewatch.com"}',
   'Luxury watch trading. Buy and resell at roughly $20k average, targeting fast inventory turns rather than speculation.'),
  ('org', 'Bitdeer', '{"Bitdeer Technologies Group"}',
   'Employer. Joint Mining Agreements and Sealminer hardware sales.'),
  ('org', '34 Ventures', '{"34 Ventures LLC"}',
   'Holding and pass-through entity.'),
  ('org', 'Adapt Nutrition', '{"Adapt Nutrition Co."}',
   'Natural electrolyte brand, co-founded.'),
  ('org', 'Servant Provisions', '{"Valor Foods"}',
   'Grass-fed beef stick brand in development.'),
  ('asset', 'WatchTrader Pro', '{"WTP"}',
   'Internal operating system for Scottsdale Watch: market board, buy desk, inventory, accounting.'),
  ('asset', 'MeatTrader Pro', '{"MTP"}',
   'Internal operating system for the meat brokering business.')
ON CONFLICT DO NOTHING;

-- Put each organisation in its space so the viewer has anchors to lay out around.
INSERT INTO entity_spaces (entity_id, space_id, role, event_count)
SELECT e.id, v.space, v.role, 0
FROM (VALUES
  ('Scottsdale Watch',  'scottsdale', 'own business'),
  ('WatchTrader Pro',   'scottsdale', 'system'),
  ('Bitdeer',           'bitdeer',    'employer'),
  ('MeatTrader Pro',    'lawrence',   'system'),
  ('34 Ventures',       'personal',   'own entity'),
  ('Adapt Nutrition',   'personal',   'own business'),
  ('Servant Provisions','personal',   'own business')
) AS v(name, space, role)
JOIN entities e ON e.name = v.name
ON CONFLICT (entity_id, space_id) DO NOTHING;
