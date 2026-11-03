# Security policy

Security fixes target the latest `main` code; Sideword is pre-1.0.

## Report a vulnerability

Private vulnerability reporting is currently disabled for this repository. Request a
private contact channel without disclosing details; keep findings out of public issues
and pull requests. Include affected versions, reproduction and impact in the private
report. If reporting is enabled later, use GitHub **Security → Report a vulnerability**.
Initial acknowledgement is expected within seven days; resolution depends on severity.

## Security limits

V1 has no recipient forward secrecy or post-compromise recovery; first-use pins cannot
authenticate initial keys or malicious served code.
Read the [security review](docs/SECURITY_REVIEW.md) and [protocol](docs/PROTOCOL.md).
