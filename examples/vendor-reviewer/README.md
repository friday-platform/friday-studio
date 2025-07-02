# Vendor-Reviewer Workspace

A comprehensive SOC 2 vendor security evaluation workspace that uses strict template formatting to ensure consistent, structured output perfect for compliance workflows.

## Overview

This workspace demonstrates Atlas's advanced capabilities for compliance automation:

- **Strict Template Formatting** - "Template Filling System" approach ensures consistent output
- **Three-Agent Workflow** - Specialized document analysis, questionnaire evaluation, and vendor assessment
- **SOC 2 Compliance Focus** - Evaluates 10 critical security questions with supporting evidence
- **Atlas Library Integration** - Automatically stores evaluation reports for audit trails
- **Memory Learning** - Workspace learns evaluation patterns and improves over time

### Agent Architecture (SOC 2 Evaluation Workflow)

1. **document-reader** - Analyzes vendor documentation (SOC 2 reports, DPAs, policies)
2. **questionnaire-analyzer** - Evaluates security questionnaire responses against SOC 2 criteria
3. **vendor-evaluator** - Creates final recommendation using strict template formatting

## Quick Start

### 1. Setup Prerequisites

```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY=your-key-here
# OR
echo "ANTHROPIC_API_KEY=your-key-here" > .env
```

### 2. Start Atlas Daemon

```bash
# Start the Atlas daemon
atlas daemon start

# Verify daemon is running
atlas daemon status
```

### 3. Add the Workspace

```bash
# Navigate to the workspace directory
cd examples/vendor-reviewer

# Add workspace to Atlas
atlas workspace add .

# Verify workspace is loaded
atlas workspace list
```

### 4. Prepare Vendor Documents

Create a directory structure for vendor evaluation:

```bash
# Create vendor document directory (adjust path as needed)
mkdir -p ~/vendor-evaluation/cloudflare

# Place vendor documents in the directory:
# - SOC 2 Type II reports
# - Data Processing Agreements (DPA)
# - Penetration test reports
# - Security questionnaires
# - Compliance certifications
```

### 5. Run Vendor Evaluation

#### Option A: Full Document + Questionnaire Analysis

```bash
# Trigger comprehensive analysis
atlas signal trigger cli-vendor-review \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Cloudflare",
    "documents_path": "~/vendor-evaluation/cloudflare",
    "questionnaire_path": "~/vendor-evaluation/cloudflare/security_questionnaire.xlsx"
  }'
```

#### Option B: Quick Template-Based Evaluation

```bash
# Generate template-formatted report directly
atlas signal trigger cli-vendor-final-evaluation \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Cloudflare",
    "evaluation_summary": "SOC 2 Type II certified, ISO 27001:2022 compliant, regular penetration testing, comprehensive DPA available, strong encryption practices"
  }'
```

### 6. Monitor Progress

```bash
# List active sessions
atlas ps

# View workspace logs
atlas workspace logs vendor-reviewer

# Check Atlas Library for completed reports
atlas library list
```

## Expected Output Format

The workspace produces structured reports in exactly this format:

```markdown
# Vendor Security Questionnaire (Cloudflare)
The answers are based on the best-in-class documentation provided for the Cloudflare platform.

| # | Question | Response | Supporting Evidence |
|---|----------|----------|-------------------|
| 1 | Does the vendor have a SOC 2 Type II report? | Yes | Cloudflare has SOC 2 Type II certification with clean audit opinion. |
| 2 | Does your company have an ISO 27001 certification? | Yes | Cloudflare holds ISO/IEC 27001:2022 certificate valid until January 6, 2028. |
| 3 | Does your company perform annual penetration testing? | Yes | Regular penetration testing performed with zero findings. |
| 4 | Does your company have a Data Processing Agreement (DPA)? | Yes | Comprehensive DPA available updated February 15, 2024. |
| 5 | Does your company have a Business Continuity/Disaster Recovery plan? | Yes | Documented incident response plan in place. |
| 6 | Does your company have an incident response plan? | Yes | Documented incident response plan in place. |
| 7 | Are your employees required to undergo security awareness training? | Yes | Security training required for employees. |
| 8 | Does your company encrypt data at rest and in transit? | Yes | Strong encryption practices (AES-256, TLS 1.2+). |
| 9 | Are you compliant with GDPR? | Yes | GDPR compliant with appropriate SCCs. |
| 10 | Are you compliant with CCPA? | Yes | CCPA compliant with appropriate SCCs. |

## Summary of Findings (Cloudflare)

**Documents & Resources Reviewed:**
Cloudflare SOC 2 documents and security questionnaire

**Evaluation Summary:**
Based on analysis of Cloudflare SOC 2 documents and security questionnaire: SOC 2 Type II certified with clean audit opinion, ISO 27001:2022 certified, regular penetration testing performed with zero findings, comprehensive DPA available, documented incident response plan, security training required for employees, strong encryption practices (AES-256, TLS 1.2+), GDPR and CCPA compliant with appropriate SCCs

**Identified Gaps for Follow-up:**
None identified based on current analysis.

**Conclusion & Recommendation:**
Cloudflare demonstrates excellent security posture and compliance. Recommend proceeding with engagement.
```

## Project Structure

```
vendor-reviewer/
├── workspace.yml                          # Workspace configuration
├── README.md                              # This documentation
├── security_questionnaire_template.xlsx   # Example vendor questionnaire template
└── .atlas/                                # Runtime data (auto-created)
    ├── memory/                            # Evaluation patterns and learning
    └── logs/                              # Session execution logs
```

## Configuration

The `workspace.yml` file defines:

- **Signal Configurations** - CLI triggers for different evaluation types
- **Agent Definitions** - Three specialized agents with specific prompts
- **Job Workflows** - Sequential execution strategies
- **Memory Settings** - Pattern learning and retention (2 years)
- **MCP Tools** - Filesystem access for document reading

### Available Signals & Workflows

1. **`cli-vendor-review`** - Full document and questionnaire analysis
   - **Agents**: document-reader → questionnaire-analyzer
   - **Purpose**: Comprehensive analysis of all vendor materials
   - **Input**: vendor_name, documents_path, questionnaire_path

2. **`cli-vendor-final-evaluation`** - Template-based report generation
   - **Agent**: vendor-evaluator (using strict template)
   - **Purpose**: Generate formatted report from summary information
   - **Input**: vendor_name, evaluation_summary

## How It Works

### Full Analysis Workflow (cli-vendor-review)

1. **Signal Triggered** - Provide vendor name and document paths
2. **Document Analysis** - document-reader agent analyzes all vendor files
3. **Questionnaire Analysis** - questionnaire-analyzer evaluates security responses
4. **Structured Summary** - Both agents provide concise findings
5. **Final Evaluation** - Manual trigger of vendor-evaluator with combined findings

### Quick Evaluation Workflow (cli-vendor-final-evaluation)

1. **Signal Triggered** - Provide vendor name and evaluation summary
2. **Template Processing** - vendor-evaluator acts as "template filling system"
3. **Structured Output** - Produces exact format with vendor-specific content
4. **Library Storage** - Report automatically stored in Atlas Library

### Key Innovation: Template Formatting System

The vendor-evaluator agent uses a revolutionary "EMERGENCY OVERRIDE: TEMPLATE FILLING SYSTEM" approach:

- **Forces consistency**: LLM acts as form-filling robot, not creative writer
- **Eliminates variation**: Same structure every time, different content
- **Compliance-ready**: Perfect for SOC 2 audits requiring standardized documentation
- **Copy-paste ready**: Output can be directly used in compliance reports

## CLI Examples

### Comprehensive Vendor Analysis

```bash
# Full analysis of Cloudflare vendor
atlas signal trigger cli-vendor-review \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Cloudflare",
    "documents_path": "/Users/username/vendor-docs/cloudflare",
    "questionnaire_path": "/Users/username/vendor-docs/cloudflare/questionnaire.xlsx"
  }'

# After analysis completes, generate final report
atlas signal trigger cli-vendor-final-evaluation \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Cloudflare", 
    "evaluation_summary": "Analysis completed: SOC 2 certified, strong security controls identified"
  }'
```

### Quick Template Generation

```bash
# Generate report for pre-analyzed vendor
atlas signal trigger cli-vendor-final-evaluation \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "AWS",
    "evaluation_summary": "SOC 2 Type II certified, ISO 27001 compliant, FedRAMP authorized, comprehensive security documentation available"
  }'
```

### Session Monitoring

```bash
# Monitor active sessions
atlas ps

# Get detailed session information
atlas session get <session-id>

# View workspace logs
atlas workspace logs vendor-reviewer

# Check completed reports in library
atlas library list | grep vendor
```

## Document Preparation Guidelines

### Using the Included Template

The workspace includes `security_questionnaire_template.xlsx` - a ready-to-use questionnaire template:

```bash
# Copy template for your vendor evaluation
cp examples/vendor-reviewer/security_questionnaire_template.xlsx ~/vendor-evaluation/cloudflare/security_questionnaire.xlsx

# Edit the Excel file to add vendor responses
# Then use it in your evaluation:
atlas signal trigger cli-vendor-review \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Cloudflare",
    "documents_path": "~/vendor-evaluation/cloudflare",
    "questionnaire_path": "~/vendor-evaluation/cloudflare/security_questionnaire.xlsx"
  }'
```

### Required Documents

For optimal analysis, provide these vendor documents:

1. **SOC 2 Type II Report** (most recent)
2. **ISO 27001 Certificate** (if available)
3. **Data Processing Agreement (DPA)**
4. **Penetration Testing Reports** (annual)
5. **Security Questionnaire Responses**
6. **Business Continuity/Disaster Recovery Plans**
7. **Incident Response Documentation**
8. **Security Training Policies**
9. **Encryption Standards Documentation**
10. **GDPR/CCPA Compliance Statements**

### File Organization

```
vendor-evaluation/
├── cloudflare/
│   ├── soc2_type2_report_2024.pdf
│   ├── iso27001_certificate.pdf
│   ├── data_processing_agreement.pdf
│   ├── penetration_test_report_2024.pdf
│   ├── security_questionnaire.xlsx
│   ├── incident_response_plan.pdf
│   └── business_continuity_plan.pdf
├── aws/
│   └── [similar structure]
└── vendor_templates/
    └── security_questionnaire_template.xlsx
```

## Customization

### Modifying the Template

To customize the security questions or output format:

1. Edit the vendor-evaluator agent prompt in `workspace.yml`
2. Modify the template structure in the `COPY THIS EXACTLY` section
3. Update the 10 security questions to match your requirements
4. Restart the workspace: `atlas workspace remove vendor-reviewer --yes && atlas workspace add .`

### Adding New Analysis Types

1. Create new signal definitions in `workspace.yml`
2. Add corresponding job workflows
3. Define new agents for specialized analysis
4. Update memory retention categories

### Integration with Other Systems

The workspace can be extended to integrate with:

- **Linear/Jira**: Automatic ticket creation for vendor reviews
- **Slack**: Notifications when evaluations complete
- **SharePoint/Box**: Automatic document retrieval
- **Compliance Platforms**: Direct report submission

## Security Considerations

1. **Document Access** - Ensure proper permissions for vendor document directories
2. **API Keys** - Secure Anthropic API key properly
3. **Report Storage** - Atlas Library reports contain sensitive vendor information
4. **Network Access** - Restrict workspace access in production environments
5. **Data Retention** - Configure appropriate memory retention policies

## Troubleshooting

### Common Issues

- **"File not found"** - Check document paths and permissions
- **"Agent timeout"** - Large documents may require longer processing time
- **"Template not followed"** - vendor-evaluator agent may need prompt adjustment
- **"Session incomplete"** - Check evaluation criteria in workspace.yml

### Performance Optimization

- **Large Documents**: Split large PDFs into sections
- **Batch Processing**: Process multiple vendors sequentially
- **Memory Management**: Monitor memory usage for document-heavy evaluations
- **Concurrent Sessions**: Limit parallel vendor evaluations

## Atlas Library Integration

All evaluation reports are automatically stored in Atlas Library with:

- **Report Type**: Structured vendor evaluation report
- **Session Archive**: Complete execution logs and agent outputs
- **Searchable Tags**: vendor-name, soc2-evaluation, compliance-report
- **Audit Trail**: Full provenance and execution history

Access reports via:
```bash
# List vendor evaluation reports
atlas library list | grep vendor

# Get specific report
atlas library get --id <report-id>

# Search by vendor name
atlas library search --query "Cloudflare"
```

## Advanced Usage

### Batch Vendor Processing

```bash
# Process multiple vendors with shell script
for vendor in cloudflare aws azure; do
  atlas signal trigger cli-vendor-final-evaluation \
    --workspace vendor-reviewer \
    --data "{\"vendor_name\": \"$vendor\", \"evaluation_summary\": \"Batch processing for $vendor\"}"
  sleep 60  # Wait between evaluations
done
```

### Compliance Report Generation

```bash
# Generate quarterly compliance report
atlas signal trigger cli-vendor-final-evaluation \
  --workspace vendor-reviewer \
  --data '{
    "vendor_name": "Q4_2024_Compliance_Summary",
    "evaluation_summary": "Quarterly review of all vendor SOC 2 compliance status"
  }'
```

## Next Steps

1. **Production Deployment** - Configure for secure production environment
2. **Workflow Integration** - Connect with existing compliance workflows
3. **Custom Templates** - Develop industry-specific evaluation templates
4. **Automated Scheduling** - Set up regular vendor re-evaluations
5. **Reporting Dashboard** - Build compliance overview dashboard

## Additional Resources

- [Atlas Documentation](../../../docs/)
- [SOC 2 Compliance Guide](https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/sorhome.html)
- [MCP Filesystem Provider](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [Atlas Memory System](../../../docs/memory-model-flow.md)

This workspace demonstrates how Atlas can automate compliance workflows while ensuring consistent, audit-ready documentation that meets SOC 2 requirements.