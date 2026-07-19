-- LOCAL DEVELOPMENT ONLY.
-- Every value below is fictitious. Never replace this file with production data.

update public.supplier_settings
set legal_name = 'Fornitore IGEA DEMO - NON USARE',
    owner_name = 'Titolare Dimostrativo',
    vat_number = 'IT00000000000',
    tax_code = 'DEMO00000000000',
    email = 'fornitore@example.invalid',
    phone = '+39 000 0000000',
    pec = 'fornitore@pec.example.invalid',
    sdi_code = 'DEMO000',
    registered_address = jsonb_build_object(
      'street', 'Via Dimostrazione 1',
      'city', 'Città Demo',
      'province', 'XX',
      'postalCode', '00000',
      'country', 'Italia'
    ),
    shipping_origin = jsonb_build_object(
      'street', 'Via Laboratorio Demo 2',
      'city', 'Città Demo',
      'province', 'XX',
      'postalCode', '00000',
      'country', 'Italia'
    ),
    bank_name = 'Banca Demo',
    iban = 'IT00D0000000000000000000000'
where id = 1;

insert into public.price_lists (id, name, currency, active)
values ('00000000-0000-4000-8000-000000000001', 'Listino base dimostrativo', 'EUR', true)
on conflict (id) do update
set name = excluded.name,
    currency = excluded.currency,
    active = excluded.active;

insert into public.products (
  id, sku, name, category, description, uom, package_label, package_size, pricing_mode, active
) values
  (
    '20000000-0000-4000-8000-000000000001',
    'DEMO-CORTA-01',
    'Formato corto dimostrativo',
    'Pasta',
    'Prodotto fittizio per lo sviluppo locale.',
    'confezione',
    'Confezione demo da 1 kg',
    1.000,
    'per_kg',
    true
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'DEMO-LUNGA-01',
    'Formato lungo dimostrativo',
    'Pasta',
    'Prodotto fittizio per lo sviluppo locale.',
    'confezione',
    'Confezione demo da 1,5 kg',
    1.500,
    'per_kg',
    true
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'DEMO-SERVIZIO-01',
    'Servizio dimostrativo',
    'Servizio',
    'Voce a prezzo unitario fittizia per lo sviluppo locale.',
    'unità',
    'Una unità di servizio',
    null,
    'per_unit',
    true
  )
on conflict (id) do update
set sku = excluded.sku,
    name = excluded.name,
    category = excluded.category,
    description = excluded.description,
    uom = excluded.uom,
    package_label = excluded.package_label,
    package_size = excluded.package_size,
    pricing_mode = excluded.pricing_mode,
    active = excluded.active;

insert into public.price_list_items (
  price_list_id, product_id, valid_from, valid_to, unit_price_net, vat_rate
) values
  (
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '2020-01-01',
    null,
    7.37,
    10.00
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '2020-01-01',
    null,
    8.63,
    10.00
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '2020-01-01',
    null,
    2.00,
    22.00
  )
on conflict (price_list_id, product_id, valid_from) do update
set valid_to = excluded.valid_to,
    unit_price_net = excluded.unit_price_net,
    vat_rate = excluded.vat_rate;

insert into public.customers (
  id,
  legal_name,
  contact_name,
  vat_number,
  tax_code,
  sdi_code,
  pec,
  email,
  phone,
  billing_address,
  shipping_address,
  price_list_id,
  payment_method,
  active
) values (
  '30000000-0000-4000-8000-000000000001',
  'Cliente dimostrativo - NON REALE',
  'Referente Demo',
  'IT11111111111',
  'DEMO11111111111',
  'DEMO111',
  'cliente@pec.example.invalid',
  'cliente@example.invalid',
  '+39 000 0000001',
  jsonb_build_object(
    'street', 'Piazza Esempio 10',
    'city', 'Città Demo',
    'province', 'XX',
    'postalCode', '00000',
    'country', 'Italia'
  ),
  jsonb_build_object(
    'street', 'Piazza Consegna 11',
    'city', 'Città Demo',
    'province', 'XX',
    'postalCode', '00000',
    'country', 'Italia'
  ),
  '00000000-0000-4000-8000-000000000001',
  'end_of_month',
  true
)
on conflict (id) do update
set legal_name = excluded.legal_name,
    contact_name = excluded.contact_name,
    vat_number = excluded.vat_number,
    tax_code = excluded.tax_code,
    sdi_code = excluded.sdi_code,
    pec = excluded.pec,
    email = excluded.email,
    phone = excluded.phone,
    billing_address = excluded.billing_address,
    shipping_address = excluded.shipping_address,
    price_list_id = excluded.price_list_id,
    payment_method = excluded.payment_method,
    active = excluded.active;

-- Auth users are intentionally not seeded. Create local login identities in Studio
-- or through the admin-users Edge Function, then attach them to this demo customer.
