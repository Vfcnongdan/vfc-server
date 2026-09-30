import { Injectable, Logger } from '@nestjs/common';
import { User, Agency, Farmer, Mdo, Se } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UserResolverService {
  private readonly logger = new Logger(UserResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kiểm tra SĐT có được phép đăng nhập/nhận OTP không:
   * SĐT phải tồn tại trong một trong các bảng: users, agencies, farmers, mdo, se.
   */
  async isPhoneAuthorized(phoneVariants: string[]): Promise<boolean> {
    if (!phoneVariants || phoneVariants.length === 0) return false;

    const [user, agency, farmer, mdo, se] = await Promise.all([
      this.prisma.user.findFirst({
        where: { phone: { in: phoneVariants } },
        select: { id: true },
      }),
      this.prisma.agency.findFirst({
        where: { phone: { in: phoneVariants } },
        select: { id: true },
      }),
      this.prisma.farmer.findFirst({
        where: { phone: { in: phoneVariants } },
        select: { id: true },
      }),
      this.prisma.mdo.findFirst({
        where: { phone: { in: phoneVariants } },
        select: { id: true },
      }),
      this.prisma.se.findFirst({
        where: { phone: { in: phoneVariants } },
        select: { id: true },
      }),
    ]);

    return !!(user || agency || farmer || mdo || se);
  }

  /**
   * Kiểm tra lỗi có phải do vi phạm Unique Constraint (P2002) hay không
   */
  private isUniqueConstraintError(error: any): boolean {
    if (!error) return false;
    if (error.code === 'P2002') return true;
    if (
      typeof error.message === 'string' &&
      error.message.includes('Unique constraint failed')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Đảm bảo UserProfile luôn tồn tại cho user (chống race condition với upsert)
   */
  async ensureUserProfile(userId: string): Promise<void> {
    try {
      await this.prisma.userProfile.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          cropIds: [],
          address: null,
          notes: null,
        },
      });
    } catch (err: any) {
      if (!this.isUniqueConstraintError(err)) {
        throw err;
      }
    }
  }

  /**
   * Tự động liên kết vai trò nếu user đã tồn tại nhưng bản ghi role chưa gắn userId
   * Bọc try-catch để an toàn trước các cập nhật đồng thời
   */
  async linkRolesIfMissing(user: User, phoneVariants: string[]): Promise<void> {
    try {
      if (user.role === 'AGENCY') {
        const agency = await this.prisma.agency.findFirst({
          where: { phone: { in: phoneVariants }, userId: null },
        });
        if (agency) {
          await this.prisma.agency
            .update({
              where: { id: agency.id },
              data: { userId: user.id },
            })
            .catch((err) => {
              if (!this.isUniqueConstraintError(err)) throw err;
            });
        }
      } else if (user.role === 'FARMER') {
        const farmer = await this.prisma.farmer.findFirst({
          where: { phone: { in: phoneVariants }, userId: null },
        });
        if (farmer) {
          await this.prisma.farmer
            .update({
              where: { id: farmer.id },
              data: { userId: user.id },
            })
            .catch((err) => {
              if (!this.isUniqueConstraintError(err)) throw err;
            });
        }
      } else if (user.role === 'MDO') {
        const mdo = await this.prisma.mdo.findFirst({
          where: { phone: { in: phoneVariants }, userId: null },
        });
        if (mdo) {
          await this.prisma.mdo
            .update({
              where: { id: mdo.id },
              data: { userId: user.id },
            })
            .catch((err) => {
              if (!this.isUniqueConstraintError(err)) throw err;
            });
        }
      } else if (user.role === 'SE') {
        const se = await this.prisma.se.findFirst({
          where: { phone: { in: phoneVariants }, userId: null },
        });
        if (se) {
          await this.prisma.se
            .update({
              where: { id: se.id },
              data: { userId: user.id },
            })
            .catch((err) => {
              if (!this.isUniqueConstraintError(err)) throw err;
            });
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to link role for user ${user.id}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Đăng nhập đại lý (Agency): tìm theo SĐT -> liên kết hoặc tạo mới
   */
  async resolveAgencyUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    const agency = await this.prisma.agency.findFirst({
      where: { phone: { in: phoneVariants } },
    });
    if (!agency) return null;

    if (agency.userId) {
      const linked = await this.prisma.user.findUnique({
        where: { id: agency.userId },
      });
      if (!linked) return null;
      return this.prisma.user.update({
        where: { id: linked.id },
        data: { lastLoginAt: new Date(), sessionToken },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: agency.phone ?? loginPhone,
          role: 'AGENCY',
          name: agency.name,
          sessionToken,
        },
      });
      await tx.agency.update({
        where: { id: agency.id },
        data: { userId: created.id },
      });
      return created;
    });
  }

  /**
   * Đăng nhập MDO: tìm theo SĐT -> liên kết hoặc tạo mới
   */
  async resolveMdoUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    const mdo = await this.prisma.mdo.findFirst({
      where: { phone: { in: phoneVariants } },
    });
    if (!mdo) return null;

    if (mdo.userId) {
      const linked = await this.prisma.user.findUnique({
        where: { id: mdo.userId },
      });
      if (!linked) return null;
      return this.prisma.user.update({
        where: { id: linked.id },
        data: { lastLoginAt: new Date(), sessionToken },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: mdo.phone ?? loginPhone,
          role: 'MDO',
          name: mdo.name,
          sessionToken,
        },
      });
      await tx.mdo.update({
        where: { id: mdo.id },
        data: { userId: created.id },
      });
      return created;
    });
  }

  /**
   * Đăng nhập SE: tìm theo SĐT -> liên kết hoặc tạo mới
   */
  async resolveSeUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    const se = await this.prisma.se.findFirst({
      where: { phone: { in: phoneVariants } },
    });
    if (!se) return null;

    if (se.userId) {
      const linked = await this.prisma.user.findUnique({
        where: { id: se.userId },
      });
      if (!linked) return null;
      return this.prisma.user.update({
        where: { id: linked.id },
        data: { lastLoginAt: new Date(), sessionToken },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: se.phone ?? loginPhone,
          role: 'SE',
          name: se.name,
          sessionToken,
        },
      });
      await tx.se.update({
        where: { id: se.id },
        data: { userId: created.id },
      });
      return created;
    });
  }

  /**
   * Đăng nhập Nông dân (Farmer): tìm theo SĐT -> liên kết hoặc tạo mới + crop matching
   */
  async resolveFarmerUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    const farmer = await this.prisma.farmer.findFirst({
      where: { phone: { in: phoneVariants } },
    });
    if (!farmer) return null;

    if (farmer.userId) {
      const linked = await this.prisma.user.findUnique({
        where: { id: farmer.userId },
      });
      if (!linked) return null;
      return this.prisma.user.update({
        where: { id: linked.id },
        data: { lastLoginAt: new Date(), sessionToken },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: farmer.phone ?? loginPhone,
          role: 'FARMER',
          name: farmer.name,
          sessionToken,
        },
      });

      let cropIds: string[] = [];
      if (farmer.crop) {
        const normalizeStr = (s: string) =>
          s
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/^(cay|cây)\s+/i, '')
            .replace(/[^\w\s]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

        const normalizedFarmerCrop = normalizeStr(farmer.crop);
        if (normalizedFarmerCrop) {
          const allCrops = await tx.crop.findMany({
            where: { isActive: true },
          });
          const matchingCrops = allCrops.filter((crop) => {
            const normalizedCropName = normalizeStr(crop.name);
            return normalizedCropName === normalizedFarmerCrop;
          });
          cropIds = matchingCrops.map((c) => c.id);
        }
      }

      await tx.userProfile.create({
        data: {
          userId: created.id,
          cropIds,
          address: null,
          notes: null,
        },
      });

      await tx.farmer.update({
        where: { id: farmer.id },
        data: { userId: created.id },
      });
      return created;
    });
  }

  /**
   * Khóa Mutex theo số điện thoại (In-process queue)
   * Giúp tuần tự hóa các request gửi đồng thời (ví dụ trong 50ms) cho cùng một số điện thoại
   */
  private readonly phoneLocks = new Map<string, Promise<void>>();

  private async withPhoneLock<T>(phoneKey: string, fn: () => Promise<T>): Promise<T> {
    const previousLock = this.phoneLocks.get(phoneKey);
    let releaseLock: () => void = () => {};
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.phoneLocks.set(phoneKey, currentLock);

    try {
      if (previousLock) {
        // Đợi request trước đó cho SĐT này hoàn tất (thành công hoặc thất bại)
        await previousLock.catch(() => {});
      }
      return await fn();
    } finally {
      releaseLock();
      if (this.phoneLocks.get(phoneKey) === currentLock) {
        this.phoneLocks.delete(phoneKey);
      }
    }
  }

  /**
   * Điều phối tìm hoặc tạo User tổng hợp theo thứ tự ưu tiên:
   * 1. User đã tồn tại trong bảng users
   * 2. Đại lý (Agency)
   * 3. MDO
   * 4. SE
   * 5. Nông dân (Farmer)
   *
   * Được bảo vệ 2 tầng chống Race Condition:
   * - Tầng 1: In-process Mutex (withPhoneLock) serialize các request cùng SĐT
   * - Tầng 2: Optimistic retry khi gặp P2002 (Unique constraint) nếu chạy đa node/pod
   */
  async resolveUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    const lockKey =
      phoneVariants && phoneVariants.length > 0
        ? [...phoneVariants].sort()[0]
        : loginPhone;

    return this.withPhoneLock(lockKey, async () => {
      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await this.executeResolveUser(
            phoneVariants,
            loginPhone,
            sessionToken,
          );
        } catch (error: any) {
          if (this.isUniqueConstraintError(error) && attempt < maxRetries) {
            this.logger.warn(
              `Race condition detected for phone ${loginPhone} (P2002, attempt ${attempt + 1}/${maxRetries}). Retrying resolveUser...`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, 50 * (attempt + 1)),
            );
            continue;
          }
          throw error;
        }
      }
      return null;
    });
  }

  /**
   * Thực thi logic tìm hoặc tạo user
   */
  private async executeResolveUser(
    phoneVariants: string[],
    loginPhone: string,
    sessionToken: string,
  ): Promise<User | null> {
    let user = await this.prisma.user.findFirst({
      where: { phone: { in: phoneVariants } },
    });

    if (user) {
      await this.linkRolesIfMissing(user, phoneVariants);
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), sessionToken },
      });
    } else {
      user = await this.resolveAgencyUser(
        phoneVariants,
        loginPhone,
        sessionToken,
      );
      if (!user) {
        user = await this.resolveMdoUser(
          phoneVariants,
          loginPhone,
          sessionToken,
        );
      }
      if (!user) {
        user = await this.resolveSeUser(
          phoneVariants,
          loginPhone,
          sessionToken,
        );
      }
      if (!user) {
        user = await this.resolveFarmerUser(
          phoneVariants,
          loginPhone,
          sessionToken,
        );
      }
    }

    if (user) {
      await this.ensureUserProfile(user.id);
    }

    return user;
  }
}
