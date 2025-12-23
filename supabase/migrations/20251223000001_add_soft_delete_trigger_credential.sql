-- Add soft delete trigger to credential table
-- Converts DELETE to UPDATE deleted_at for audit trail

CREATE TRIGGER credential_soft_delete
BEFORE DELETE ON public.credential
FOR EACH ROW
EXECUTE FUNCTION _tempest.soft_delete();
