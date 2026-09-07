export const isNotSecuredEnvironment = (value = process.env.NOT_SECURED) =>
  value?.trim().toLowerCase() === 'true';

export const isSecuredEnvironment = (value = process.env.NOT_SECURED) =>
  !isNotSecuredEnvironment(value);
