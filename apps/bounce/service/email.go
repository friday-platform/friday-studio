package service

import (
	"errors"

	"github.com/sendgrid/sendgrid-go"
	"github.com/sendgrid/sendgrid-go/helpers/mail"
)

type SendgridEmailConfig struct {
	TemplateID     string
	Data           map[string]interface{}
	RecipientName  string
	RecipientEmail string
	SenderName     string
	SenderEmail    string
	apiKey         string
}

func newSendgridEmail(cfg Config, opts *SendgridEmailConfig) (SendgridEmailConfig, error) {
	if cfg.SendgridAPIKey == "" {
		return SendgridEmailConfig{}, errors.New("sendgrid api key is required")
	}

	if opts.TemplateID == "" {
		return SendgridEmailConfig{}, errors.New("template id is required")
	}

	if opts.RecipientEmail == "" {
		return SendgridEmailConfig{}, errors.New("recipient email is required")
	}

	if opts.RecipientName == "" {
		return SendgridEmailConfig{}, errors.New("recipient name is required")
	}

	if opts.SenderEmail == "" {
		opts.SenderEmail = "noreply@" + cfg.EmailDomain
	}

	if opts.SenderName == "" {
		opts.SenderName = "Tempest"
	}

	for k, v := range opts.Data {
		strVal, ok := v.(string)
		if !ok || strVal == "" {
			return SendgridEmailConfig{}, errors.New("data key " + k + " must be a non-empty string")
		}
	}

	opts.apiKey = cfg.SendgridAPIKey
	return *opts, nil
}

func (s SendgridEmailConfig) Send() error {
	from := mail.NewEmail(s.SenderName, s.SenderEmail)
	to := mail.NewEmail(s.RecipientName, s.RecipientEmail)

	m := mail.NewV3Mail()
	m.SetFrom(from)
	m.SetTemplateID(s.TemplateID)

	p := mail.NewPersonalization()
	p.AddTos(to)

	// Add dynamic template data
	p.DynamicTemplateData = s.Data
	m.AddPersonalizations(p)

	client := sendgrid.NewSendClient(s.apiKey)
	_, err := client.Send(m)
	return err
}
