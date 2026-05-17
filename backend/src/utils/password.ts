import bcrypt from 'bcryptjs';

export const hashPassword = async (plain: string): Promise<string> => {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(plain, salt);
};

export const comparePassword = async (plain: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(plain, hash);
};
