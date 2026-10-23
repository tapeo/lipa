const configured = process.env.LIPA_VERSION;

export const VERSION = configured === undefined || configured === '' ? 'dev' : configured;
