-- Add stripe_customer_id column to public.user for Stripe billing integration
ALTER TABLE public."user" ADD COLUMN stripe_customer_id TEXT;
