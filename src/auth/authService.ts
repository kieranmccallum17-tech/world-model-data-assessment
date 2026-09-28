import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../domain/errors';
import { AuthUser } from '../domain/types';
import { ChatRepository } from '../persistence/chatRepository';

export class AuthService {
  constructor(private readonly repository: ChatRepository) {}

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const user = await this.repository.findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw unauthorized();
    }
    const token = jwt.sign(
      { role: user.role },
      config.JWT_SECRET,
      { subject: user.id, expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'] }
    );
    const { passwordHash: _passwordHash, ...publicUser } = user;
    return { token, user: publicUser };
  }

  async authenticate(token: string): Promise<AuthUser> {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.JWT_SECRET);
    } catch {
      throw unauthorized();
    }
    if (typeof payload === 'string' || !payload.sub) throw unauthorized();
    const user = await this.repository.findUserById(payload.sub);
    if (!user) throw unauthorized();
    return user;
  }
}