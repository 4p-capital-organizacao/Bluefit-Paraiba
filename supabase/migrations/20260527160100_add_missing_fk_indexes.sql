-- Cria índices para as 11 foreign keys sem índice flagadas pelo advisor.
-- Acelera joins e cascading deletes nessas tabelas hot-path.

-- contacts
CREATE INDEX IF NOT EXISTS idx_contacts_id_lead
  ON public.contacts (id_lead);
CREATE INDEX IF NOT EXISTS idx_contacts_id_profile_created
  ON public.contacts (id_profile_created);

-- leads
CREATE INDEX IF NOT EXISTS idx_leads_id_contact
  ON public.leads (id_contact);
CREATE INDEX IF NOT EXISTS idx_leads_id_unidade
  ON public.leads (id_unidade);

-- profiles
CREATE INDEX IF NOT EXISTS idx_profiles_id_cargo
  ON public.profiles (id_cargo);
CREATE INDEX IF NOT EXISTS idx_profiles_id_unidade
  ON public.profiles (id_unidade);

-- conversation_assignments
CREATE INDEX IF NOT EXISTS idx_conv_assignments_assigned_by_user_id
  ON public.conversation_assignments (assigned_by_user_id);

-- conversation_events
CREATE INDEX IF NOT EXISTS idx_conv_events_actor_user_id
  ON public.conversation_events (actor_user_id);

-- automated_message_log
CREATE INDEX IF NOT EXISTS idx_automated_message_log_contact_id
  ON public.automated_message_log (contact_id);
CREATE INDEX IF NOT EXISTS idx_automated_message_log_conversation_id
  ON public.automated_message_log (conversation_id);

-- contact_tags
CREATE INDEX IF NOT EXISTS idx_contact_tags_user_id
  ON public.contact_tags (user_id);
