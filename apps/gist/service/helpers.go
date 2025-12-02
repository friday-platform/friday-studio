package service

import (
	"strings"

	"github.com/google/uuid"
)

// ObjectPath generates the GCS object path for a given UUID.
// For UUID "9b378f95-23db-49aa-87d8-8e51dc79b2fc", returns "9b378f95/23db/9b378f95-23db-49aa-87d8-8e51dc79b2fc".
func ObjectPath(id uuid.UUID) string {
	s := id.String()
	parts := strings.Split(s, "-")
	return parts[0] + "/" + parts[1] + "/" + s
}
