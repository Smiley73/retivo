// loadSecretsFromSsm() cold-start behaviour with SSMClient.send mocked. A throttled, denied or absent GetParameter for the required edge/shared-secret entry must reject the whole cold start
// rather than degrade EdgeAuthMiddleware to a pass-through for the life of the warm Lambda; this exercises the loader itself, which nothing else covers.
const send = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: jest.fn().mockImplementation(() => ({ send })),
  };
});

import { loadSecretsFromSsm } from './ssm-bootstrap.js';

type SendableCommand = { input: { Name: string } };

const ORIGINAL_ENV = { ...process.env };

function resolved(value: string) {
  return Promise.resolve({ Parameter: { Value: value } });
}

function mockAllExcept(name: string, behavior: () => Promise<unknown>) {
  send.mockImplementation((command: SendableCommand) => {
    if (command.input.Name.endsWith(name)) return behavior();
    return resolved('placeholder');
  });
}

describe('loadSecretsFromSsm', () => {
  beforeEach(() => {
    send.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.STACK = 'test-stack';
    delete process.env.DYNAMODB_ENDPOINT;
    delete process.env.EDGE_SHARED_SECRET;
    delete process.env.SES_FROM_ADDRESS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('rejects when the required edge/shared-secret GetParameter throws', async () => {
    mockAllExcept('/edge/shared-secret', () =>
      Promise.reject(new Error('AccessDeniedException')),
    );

    await expect(loadSecretsFromSsm()).rejects.toThrow('AccessDeniedException');
    expect(process.env.EDGE_SHARED_SECRET).toBeUndefined();
  });

  it('rejects when the required edge/shared-secret GetParameter resolves with an empty value', async () => {
    mockAllExcept('/edge/shared-secret', () => resolved(''));

    await expect(loadSecretsFromSsm()).rejects.toThrow(
      /edge\/shared-secret returned no value/,
    );
    expect(process.env.EDGE_SHARED_SECRET).toBeUndefined();
  });

  it('does not reject the cold start when an optional parameter (ses/from-address) fails the same way', async () => {
    mockAllExcept('/ses/from-address', () =>
      Promise.reject(new Error('ThrottlingException')),
    );

    await expect(loadSecretsFromSsm()).resolves.toBeUndefined();
    expect(process.env.SES_FROM_ADDRESS).toBeUndefined();
    expect(process.env.EDGE_SHARED_SECRET).toBe('placeholder');
  });
});
