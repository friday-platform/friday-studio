package middleware

type ContextKey struct {
	Name string
}

// Concurrency safe for set-once read heavy use cases.
var keyMap = make(map[string]*ContextKey)

func AddContextKey(name string) *ContextKey {
	if keyMap[name] != nil {
		panic("middleware: key already exists: " + name)
	}

	ctxKey := &ContextKey{Name: name}
	keyMap[name] = ctxKey

	return ctxKey
}

func GetContextKey(name string) *ContextKey {
	return keyMap[name]
}

// ContextKeyMap returns a map of all the context keys.
func ContextKeyMap() map[string]*ContextKey {
	return keyMap
}
