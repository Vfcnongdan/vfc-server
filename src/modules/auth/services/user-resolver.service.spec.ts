import { Test, TestingModule } from '@nestjs/testing';
import { UserResolverService } from './user-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';

describe('UserResolverService', () => {
  let service: UserResolverService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      agency: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      farmer: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      mdo: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      se: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      userProfile: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      crop: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(prismaMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserResolverService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<UserResolverService>(UserResolverService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('isPhoneAuthorized', () => {
    it('should return true if phone exists in user table', async () => {
      prismaMock.user.findFirst.mockResolvedValue({ id: 'u1' });
      prismaMock.agency.findFirst.mockResolvedValue(null);
      prismaMock.farmer.findFirst.mockResolvedValue(null);
      prismaMock.mdo.findFirst.mockResolvedValue(null);
      prismaMock.se.findFirst.mockResolvedValue(null);

      const result = await service.isPhoneAuthorized(['0988366412', '84988366412']);
      expect(result).toBe(true);
    });

    it('should return true if phone exists in agency table', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.agency.findFirst.mockResolvedValue({ id: 'ag1' });
      prismaMock.farmer.findFirst.mockResolvedValue(null);
      prismaMock.mdo.findFirst.mockResolvedValue(null);
      prismaMock.se.findFirst.mockResolvedValue(null);

      const result = await service.isPhoneAuthorized(['0988366412']);
      expect(result).toBe(true);
    });

    it('should return false if phone does not exist anywhere', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.agency.findFirst.mockResolvedValue(null);
      prismaMock.farmer.findFirst.mockResolvedValue(null);
      prismaMock.mdo.findFirst.mockResolvedValue(null);
      prismaMock.se.findFirst.mockResolvedValue(null);

      const result = await service.isPhoneAuthorized(['0988366412']);
      expect(result).toBe(false);
    });
  });

  describe('resolveUser', () => {
    it('should resolve and update existing user if found in users table', async () => {
      const existingUser = {
        id: 'u1',
        phone: '0988366412',
        role: Role.FARMER,
        name: 'Nguyễn Văn A',
      };
      prismaMock.user.findFirst.mockResolvedValue(existingUser);
      prismaMock.user.update.mockResolvedValue({
        ...existingUser,
        sessionToken: 'sess_123',
      });
      prismaMock.userProfile.findUnique.mockResolvedValue({ userId: 'u1' });

      const resolved = await service.resolveUser(
        ['0988366412'],
        '0988366412',
        'sess_123',
      );

      expect(resolved).toBeDefined();
      expect(resolved?.id).toBe('u1');
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: expect.objectContaining({ sessionToken: 'sess_123' }),
        }),
      );
    });

    it('should create new AGENCY user if not found in users but exists in agencies', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.agency.findFirst.mockResolvedValue({
        id: 'ag_1',
        name: 'Đại Lý ABC',
        phone: '0988366412',
        userId: null,
      });
      prismaMock.user.create.mockResolvedValue({
        id: 'new_u_agency',
        phone: '0988366412',
        role: Role.AGENCY,
        name: 'Đại Lý ABC',
        sessionToken: 'sess_123',
      });
      prismaMock.userProfile.findUnique.mockResolvedValue(null);
      prismaMock.userProfile.create.mockResolvedValue({ id: 'p1' });

      const resolved = await service.resolveUser(
        ['0988366412'],
        '0988366412',
        'sess_123',
      );

      expect(resolved).toBeDefined();
      expect(resolved?.role).toBe(Role.AGENCY);
      expect(prismaMock.agency.update).toHaveBeenCalledWith({
        where: { id: 'ag_1' },
        data: { userId: 'new_u_agency' },
      });
    });

    it('should serialize concurrent resolveUser requests and prevent race condition', async () => {
      let resolveCallCount = 0;
      prismaMock.user.findFirst.mockImplementation(async () => {
        resolveCallCount++;
        if (resolveCallCount === 1) {
          // Request 1: user not found initially
          return null;
        }
        // Request 2 (queued): sees user already created by Request 1
        return {
          id: 'u_created_by_req1',
          phone: '0988366412',
          role: Role.FARMER,
          name: 'Farmer Test',
        };
      });

      prismaMock.farmer.findFirst.mockResolvedValue({
        id: 'farmer_1',
        phone: '0988366412',
        name: 'Farmer Test',
        userId: null,
      });

      prismaMock.user.create.mockResolvedValue({
        id: 'u_created_by_req1',
        phone: '0988366412',
        role: Role.FARMER,
        name: 'Farmer Test',
        sessionToken: 'token_1',
      });

      prismaMock.user.update.mockImplementation(async ({ data }) => ({
        id: 'u_created_by_req1',
        phone: '0988366412',
        role: Role.FARMER,
        name: 'Farmer Test',
        sessionToken: data.sessionToken,
      }));

      // Fire 2 concurrent requests within milliseconds
      const [res1, res2] = await Promise.all([
        service.resolveUser(['0988366412'], '0988366412', 'token_1'),
        service.resolveUser(['0988366412'], '0988366412', 'token_2'),
      ]);

      expect(res1?.id).toBe('u_created_by_req1');
      expect(res2?.id).toBe('u_created_by_req1');
      // Only 1 user should be created
      expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
    });

    it('should retry and succeed when P2002 unique constraint error occurs', async () => {
      let createAttempt = 0;
      prismaMock.user.findFirst.mockImplementation(async () => {
        if (createAttempt === 0) {
          return null;
        }
        return {
          id: 'u_concurrent_winner',
          phone: '0988366412',
          role: Role.AGENCY,
          name: 'Đại Lý ABC',
        };
      });

      prismaMock.agency.findFirst.mockResolvedValue({
        id: 'ag_1',
        name: 'Đại Lý ABC',
        phone: '0988366412',
        userId: null,
      });

      prismaMock.user.create.mockImplementation(async () => {
        createAttempt++;
        const p2002Error: any = new Error('Unique constraint failed on the fields: (`phone`)');
        p2002Error.code = 'P2002';
        throw p2002Error;
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'u_concurrent_winner',
        phone: '0988366412',
        role: Role.AGENCY,
        name: 'Đại Lý ABC',
        sessionToken: 'sess_retry',
      });

      const resolved = await service.resolveUser(
        ['0988366412'],
        '0988366412',
        'sess_retry',
      );

      expect(resolved).toBeDefined();
      expect(resolved?.id).toBe('u_concurrent_winner');
    });
  });
});
